export function matchRoute(pathname, config, hostHeader = null) {
    const routes = Object.keys(config.backends);
    if (routes.length === 0) return null;

    const hostRouting = config.hostRouting === true;
    let bestMatch = null;
    let bestLength = -1;

    for (const route of routes) {
        const hasHostPrefix = route.includes('/') && route.indexOf('/') > 0;

        if (hostRouting && hasHostPrefix) {
            if (hostHeader === null) continue;

            const routeHost = route.substring(0, route.indexOf('/'));
            const routePath = route.substring(route.indexOf('/'));

            if (!hostMatches(hostHeader, routeHost)) continue;

            if (pathMatches(pathname, routePath)) {
                if (route.length > bestLength) {
                    bestLength = route.length;
                    bestMatch = route;
                }
            }
        } else if (!hostRouting && !hasHostPrefix) {
            if (pathMatches(pathname, route)) {
                if (route.length > bestLength) {
                    bestLength = route.length;
                    bestMatch = route;
                }
            }
        } else if (hostRouting && !hasHostPrefix) {
            if (pathMatches(pathname, route)) {
                if (route.length > bestLength) {
                    bestLength = route.length;
                    bestMatch = route;
                }
            }
        }
    }

    return bestMatch;
}

function pathMatches(pathname, route) {
    if (pathname === route) return true;
    if (pathname.startsWith(route)) {
        const nextChar = pathname[route.length];
        return nextChar === '/' || nextChar === undefined;
    }
    return false;
}

function hostMatches(hostHeader, routeHost) {
    if (!hostHeader || !routeHost) return false;

    const hostLower = hostHeader.toLowerCase();
    const routeHostLower = routeHost.toLowerCase();

    if (routeHostLower.includes(':')) {
        return hostLower === routeHostLower;
    }

    if (hostLower === routeHostLower) return true;
    if (hostLower.startsWith(routeHostLower + ':')) return true;

    return false;
}

export function matchRouteLegacy(pathname, config) {
    return matchRoute(pathname, config, null);
}

export function getRoutesForHost(host, config) {
    const routes = Object.keys(config.backends);
    const hostRouting = config.hostRouting === true;
    const result = [];

    for (const route of routes) {
        const hasHostPrefix = route.includes('/') && route.indexOf('/') > 0;

        if (hostRouting && hasHostPrefix) {
            const routeHost = route.substring(0, route.indexOf('/'));
            if (hostMatches(host, routeHost)) {
                result.push(route);
            }
        } else if (!hostRouting || !hasHostPrefix) {
            result.push(route);
        }
    }

    return result;
}