import type { ComponentType, ReactNode } from "react";
import * as React from "react";
import type { Params } from "react-router";
import type { DataRouteObject } from "react-router-dom";

import type { RouteModules, ShouldReloadFunction } from "./routeModules";
import { loadRouteModule } from "./routeModules";
import {
  extractData,
  fetchData,
  isCatchResponse,
  isRedirectResponse,
} from "./data";
import type { Submission } from "./transition";
import { CatchValue } from "./transition";
import { prefetchStyleLinks } from "./links";
import invariant from "./invariant";
import { RemixRoute, RemixRouteError } from "./components";

export interface RouteManifest<Route> {
  [routeId: string]: Route;
}

// NOTE: make sure to change the Route in server-runtime if you change this
interface Route {
  index?: boolean;
  caseSensitive?: boolean;
  id: string;
  parentId?: string;
  path?: string;
}

// NOTE: make sure to change the EntryRoute in server-runtime if you change this
export interface EntryRoute extends Route {
  hasAction: boolean;
  hasLoader: boolean;
  hasCatchBoundary: boolean;
  hasErrorBoundary: boolean;
  imports?: string[];
  module: string;
  parentId?: string;
}

export type RouteDataFunction = {
  (args: {
    /**
     * Parsed params from the route path
     */
    params: Params;

    /**
     * The url to be loaded, resolved to the matched route.
     */
    url: URL; // resolved route

    /**
     * Will be present if being called from `<Form>` or `useSubmit`
     */
    submission?: Submission;

    /**
     * Attach this signal to fetch (or whatever else) to abort your
     * implementation when a load/action is aborted.
     */
    signal: AbortSignal;
  }): Promise<any> | any;
};

export interface ClientRoute extends Route {
  loader?: RouteDataFunction;
  action: RouteDataFunction;
  shouldReload?: ShouldReloadFunction;
  ErrorBoundary?: any;
  CatchBoundary?: any;
  children?: ClientRoute[];
  element: ReactNode;
  module: string;
  hasLoader: boolean;
}

type RemixRouteComponentType = ComponentType<{ id: string }>;

export function createServerRoutes(
  manifest: RouteManifest<EntryRoute>,
  routeModules: RouteModules,
  parentId?: string
): DataRouteObject[] {
  return Object.values(manifest)
    .filter((route) => route.parentId === parentId)
    .map((route) => {
      let baseRoute: Omit<DataRouteObject, "children" | "index"> = {
        caseSensitive: route.caseSensitive,
        element: <RemixRoute id={route.id} />,
        errorElement:
          route.id === "root" ||
          routeModules[route.id].ErrorBoundary != null ||
          routeModules[route.id].CatchBoundary != null ? (
            <RemixRouteError id={route.id} />
          ) : undefined,
        id: route.id,
        path: route.path,
        // Note: we don't need loader/action/shouldRevalidate on these routes
        // since they're for a static render
        handle: routeModules[route.id].handle,
      };

      return route.index
        ? {
            index: true,
            ...baseRoute,
          }
        : {
            children: createServerRoutes(manifest, routeModules, route.id),
            ...baseRoute,
          };
    });
}

export function createClientRoute(
  entryRoute: EntryRoute,
  routeModulesCache: RouteModules
): DataRouteObject {
  let loader = createLoader(entryRoute, routeModulesCache);
  let action = createAction(entryRoute, routeModulesCache);
  let hasErrorBoundary =
    entryRoute.id === "root" ||
    entryRoute.hasErrorBoundary ||
    entryRoute.hasCatchBoundary;
  return {
    caseSensitive: !!entryRoute.caseSensitive,
    element: <RemixRoute id={entryRoute.id} />,
    errorElement: hasErrorBoundary ? (
      <RemixRouteError id={entryRoute.id} />
    ) : undefined,
    id: entryRoute.id,
    path: entryRoute.path,
    index: entryRoute.index,
    loader: ({ request, params }) =>
      loader({
        url: new URL(request.url),
        signal: request.signal,
        submission: undefined,
        params,
      }),
    action: ({ request, params }) =>
      action({
        url: new URL(request.url),
        signal: request.signal,
        submission: undefined,
        params,
      }),
    // TODO: RRR Implement!
    shouldRevalidate: undefined,
  };
}

export function createClientRoutes(
  routeManifest: RouteManifest<EntryRoute>,
  routeModulesCache: RouteModules,
  parentId?: string
): DataRouteObject[] {
  return Object.keys(routeManifest)
    .filter((key) => routeManifest[key].parentId === parentId)
    .map((key) => {
      let route = createClientRoute(routeManifest[key], routeModulesCache);
      let children = createClientRoutes(
        routeManifest,
        routeModulesCache,
        route.id
      );
      if (children.length > 0) route.children = children;
      return route;
    });
}

function createShouldReload(route: EntryRoute, routeModules: RouteModules) {
  let shouldReload: ShouldReloadFunction = (arg) => {
    let module = routeModules[route.id];
    invariant(module, `Expected route module to be loaded for ${route.id}`);
    if (module.unstable_shouldReload) {
      return module.unstable_shouldReload(arg);
    }
    return true;
  };

  return shouldReload;
}

async function loadRouteModuleWithBlockingLinks(
  route: EntryRoute,
  routeModules: RouteModules
) {
  let routeModule = await loadRouteModule(route, routeModules);
  await prefetchStyleLinks(routeModule);
  return routeModule;
}

function createLoader(route: EntryRoute, routeModules: RouteModules) {
  let loader: ClientRoute["loader"] = async ({ url, signal, submission }) => {
    if (route.hasLoader) {
      let routeModulePromise = loadRouteModuleWithBlockingLinks(
        route,
        routeModules
      );
      try {
        let result = await fetchData(url, route.id, signal, submission);

        if (result instanceof Error) throw result;

        /* TODO: Handle client side redirects
        let redirect = await checkRedirect(result);
        if (redirect) return redirect;
        */

        if (isCatchResponse(result)) {
          throw new CatchValue(
            result.status,
            result.statusText,
            await extractData(result)
          );
        }

        return extractData(result);
      } finally {
        await routeModulePromise;
      }
    } else {
      await loadRouteModuleWithBlockingLinks(route, routeModules);
      return null;
    }
  };

  return loader;
}

function createAction(route: EntryRoute, routeModules: RouteModules) {
  let action: ClientRoute["action"] = async ({ url, signal, submission }) => {
    let routeModulePromise = await loadRouteModuleWithBlockingLinks(
      route,
      routeModules
    );

    try {
      if (!route.hasAction) {
        console.error(
          `Route "${route.id}" does not have an action, but you are trying ` +
            `to submit to it. To fix this, please add an \`action\` function to the route`
        );
      }

      let result = await fetchData(url, route.id, signal, submission);

      if (result instanceof Error) {
        throw result;
      }

      /* TODO: Handle client side redirects
      let redirect = await checkRedirect(result);
      if (redirect) return redirect;
      */

      if (isCatchResponse(result)) {
        throw new CatchValue(
          result.status,
          result.statusText,
          await extractData(result)
        );
      }

      return extractData(result);
    } finally {
      await routeModulePromise;
      return null;
    }
  };

  return action;
}
