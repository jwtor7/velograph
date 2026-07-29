import {
  Children,
  createContext,
  isValidElement,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type AnchorHTMLAttributes,
  type MouseEvent,
  type ReactNode,
} from 'react';

interface RouterLocation {
  pathname: string;
  search: string;
  hash: string;
}

interface NavigateOptions {
  replace?: boolean;
  state?: unknown;
}

type NavigateFunction = (to: string | number, options?: NavigateOptions) => void;

interface RouterContextValue {
  location: RouterLocation;
  navigate: NavigateFunction;
  origin: string;
}

const RouterContext = createContext<RouterContextValue | null>(null);
const ParamsContext = createContext<Readonly<Record<string, string | undefined>>>({});
const MEMORY_ORIGIN = 'http://velograph.invalid';

function locationFromUrl(url: URL): RouterLocation {
  return {
    pathname: normalizePathname(url.pathname),
    search: url.search,
    hash: url.hash,
  };
}

function normalizePathname(pathname: string): string {
  if (!pathname || pathname === '/') return '/';
  const withLeadingSlash = pathname.startsWith('/') ? pathname : `/${pathname}`;
  return withLeadingSlash.replace(/\/+$/, '') || '/';
}

function locationHref(location: RouterLocation): string {
  return `${location.pathname}${location.search}${location.hash}`;
}

function resolveDestination(to: string, location: RouterLocation, origin: string): URL {
  return new URL(to, `${origin}${locationHref(location)}`);
}

function currentBrowserLocation(): RouterLocation {
  return {
    pathname: normalizePathname(window.location.pathname),
    search: window.location.search,
    hash: window.location.hash,
  };
}

function useRouter(): RouterContextValue {
  const router = useContext(RouterContext);
  if (!router) throw new Error('Velograph router components must be rendered inside a router.');
  return router;
}

export function BrowserRouter({ children }: { children?: ReactNode }) {
  const [location, setLocation] = useState(currentBrowserLocation);
  const origin = window.location.origin;

  useEffect(() => {
    const handlePopState = () => setLocation(currentBrowserLocation());
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  const navigate = useCallback<NavigateFunction>((to, options) => {
    if (typeof to === 'number') {
      window.history.go(to);
      return;
    }

    const destination = new URL(to, window.location.href);
    if (destination.origin !== window.location.origin) {
      window.location.assign(destination.href);
      return;
    }

    const nextHref = `${destination.pathname}${destination.search}${destination.hash}`;
    if (options?.replace) {
      window.history.replaceState(options.state ?? null, '', nextHref);
    } else {
      window.history.pushState(options?.state ?? null, '', nextHref);
    }
    setLocation(currentBrowserLocation());
  }, []);

  const value = useMemo(() => ({ location, navigate, origin }), [location, navigate, origin]);

  return <RouterContext.Provider value={value}>{children}</RouterContext.Provider>;
}

interface MemoryHistory {
  entries: RouterLocation[];
  index: number;
}

function memoryLocation(entry: string): RouterLocation {
  return locationFromUrl(new URL(entry, `${MEMORY_ORIGIN}/`));
}

export function MemoryRouter({
  children,
  initialEntries = ['/'],
}: {
  children?: ReactNode;
  initialEntries?: readonly string[];
}) {
  const historyRef = useRef<MemoryHistory | null>(null);
  if (!historyRef.current) {
    const entries = (initialEntries.length > 0 ? initialEntries : ['/']).map(memoryLocation);
    historyRef.current = { entries, index: entries.length - 1 };
  }

  const history = historyRef.current;
  const [location, setLocation] = useState(history.entries[history.index]!);
  const locationRef = useRef(location);
  locationRef.current = location;

  const navigate = useCallback<NavigateFunction>((to, options) => {
    const currentHistory = historyRef.current!;
    if (typeof to === 'number') {
      const nextIndex = Math.min(
        currentHistory.entries.length - 1,
        Math.max(0, currentHistory.index + to),
      );
      currentHistory.index = nextIndex;
      const nextLocation = currentHistory.entries[nextIndex]!;
      locationRef.current = nextLocation;
      setLocation(nextLocation);
      return;
    }

    const destination = resolveDestination(to, locationRef.current, MEMORY_ORIGIN);
    if (destination.origin !== MEMORY_ORIGIN) return;
    const nextLocation = locationFromUrl(destination);

    if (options?.replace) {
      currentHistory.entries[currentHistory.index] = nextLocation;
    } else {
      currentHistory.entries.splice(currentHistory.index + 1);
      currentHistory.entries.push(nextLocation);
      currentHistory.index = currentHistory.entries.length - 1;
    }
    locationRef.current = nextLocation;
    setLocation(nextLocation);
  }, []);

  const value = useMemo(
    () => ({ location, navigate, origin: MEMORY_ORIGIN }),
    [location, navigate],
  );

  return <RouterContext.Provider value={value}>{children}</RouterContext.Provider>;
}

export interface RouteProps {
  path: string;
  element: ReactNode;
}

export function Route(props: RouteProps) {
  void props;
  return null;
}

function matchRoute(
  routePath: string,
  pathname: string,
): Readonly<Record<string, string | undefined>> | null {
  const routeSegments = normalizePathname(routePath).split('/').filter(Boolean);
  const pathSegments = normalizePathname(pathname).split('/').filter(Boolean);
  if (routeSegments.length !== pathSegments.length) return null;

  const params: Record<string, string> = {};
  for (let index = 0; index < routeSegments.length; index += 1) {
    const routeSegment = routeSegments[index]!;
    const pathSegment = pathSegments[index]!;
    if (routeSegment.startsWith(':') && routeSegment.length > 1) {
      try {
        params[routeSegment.slice(1)] = decodeURIComponent(pathSegment);
      } catch {
        return null;
      }
    } else if (routeSegment !== pathSegment) {
      return null;
    }
  }
  return params;
}

export function Routes({ children }: { children?: ReactNode }) {
  const { location } = useRouter();

  for (const child of Children.toArray(children)) {
    if (!isValidElement<RouteProps>(child) || child.type !== Route) continue;
    const params = matchRoute(child.props.path, location.pathname);
    if (params) {
      return <ParamsContext.Provider value={params}>{child.props.element}</ParamsContext.Provider>;
    }
  }

  return null;
}

export function useNavigate(): NavigateFunction {
  return useRouter().navigate;
}

export function useParams<
  Params extends Record<string, string | undefined> = Record<string, string | undefined>,
>(): Readonly<Params> {
  return useContext(ParamsContext) as Readonly<Params>;
}

export interface LinkProps extends Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'> {
  to: string;
  replace?: boolean;
  state?: unknown;
}

function shouldHandleLinkClick(
  event: MouseEvent<HTMLAnchorElement>,
  target: string | undefined,
  download: AnchorHTMLAttributes<HTMLAnchorElement>['download'],
): boolean {
  return (
    !event.defaultPrevented &&
    event.button === 0 &&
    !event.metaKey &&
    !event.altKey &&
    !event.ctrlKey &&
    !event.shiftKey &&
    (!target || target.toLowerCase() === '_self') &&
    download == null
  );
}

export function Link({ to, replace, state, onClick, target, download, ...anchorProps }: LinkProps) {
  const { location, navigate, origin } = useRouter();

  const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(event);
    if (!shouldHandleLinkClick(event, target, download)) return;

    const destination = resolveDestination(to, location, origin);
    if (destination.origin !== origin) return;

    event.preventDefault();
    const options: NavigateOptions = {};
    if (replace !== undefined) options.replace = replace;
    if (state !== undefined) options.state = state;
    navigate(to, options);
  };

  return <a {...anchorProps} href={to} target={target} download={download} onClick={handleClick} />;
}

interface NavLinkRenderProps {
  isActive: boolean;
}

export interface NavLinkProps extends Omit<LinkProps, 'aria-current' | 'className'> {
  end?: boolean;
  className?: string | ((props: NavLinkRenderProps) => string | undefined);
  'aria-current'?: AnchorHTMLAttributes<HTMLAnchorElement>['aria-current'];
}

function isActivePath(currentPath: string, targetPath: string, end: boolean): boolean {
  const current = normalizePathname(currentPath);
  const target = normalizePathname(targetPath);
  if (target === '/' || end) return current === target;
  return current === target || current.startsWith(`${target}/`);
}

export function NavLink({
  to,
  end = false,
  className,
  'aria-current': ariaCurrent,
  ...linkProps
}: NavLinkProps) {
  const { location, origin } = useRouter();
  const destination = resolveDestination(to, location, origin);
  const isActive =
    destination.origin === origin && isActivePath(location.pathname, destination.pathname, end);
  const resolvedClassName = typeof className === 'function' ? className({ isActive }) : className;

  return (
    <Link
      {...linkProps}
      to={to}
      className={resolvedClassName}
      aria-current={isActive ? (ariaCurrent ?? 'page') : undefined}
    />
  );
}
