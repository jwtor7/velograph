// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import {
  BrowserRouter,
  Link,
  MemoryRouter,
  NavLink,
  Route,
  Routes,
  useNavigate,
  useParams,
} from './router.tsx';

beforeEach(() => {
  window.history.replaceState(null, '', '/');
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.history.replaceState(null, '', '/');
});

function RideRoute() {
  const { id } = useParams();
  return <p>Ride {id}</p>;
}

function HistoryControls() {
  const navigate = useNavigate();
  return (
    <div>
      <button type="button" onClick={() => navigate(-1)}>
        Back
      </button>
      <button type="button" onClick={() => navigate(1)}>
        Forward
      </button>
    </div>
  );
}

describe('MemoryRouter', () => {
  it('matches dynamic parameters and navigates through its history stack', () => {
    render(
      <MemoryRouter initialEntries={['/', '/rides/41']}>
        <HistoryControls />
        <Link to="/import">Import</Link>
        <Routes>
          <Route path="/" element={<p>Ride library</p>} />
          <Route path="/rides/:id" element={<RideRoute />} />
          <Route path="/import" element={<p>Import rides</p>} />
        </Routes>
      </MemoryRouter>,
    );

    expect(screen.getByText('Ride 41')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(screen.getByText('Ride library')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Forward' }));
    expect(screen.getByText('Ride 41')).toBeTruthy();

    fireEvent.click(screen.getByRole('link', { name: 'Import' }));
    expect(screen.getByText('Import rides')).toBeTruthy();
  });

  it('keeps the root navigation exact and forwards accessible anchor props', () => {
    render(
      <MemoryRouter initialEntries={['/rides/41']}>
        <span id="ride-hint">Current ride</span>
        <NavLink
          to="/"
          end
          aria-label="Rides"
          className={({ isActive }) => (isActive ? 'active' : 'inactive')}
        >
          Root
        </NavLink>
        <NavLink
          to="/rides"
          aria-label="Ride section"
          aria-describedby="ride-hint"
          className={({ isActive }) => (isActive ? 'active' : 'inactive')}
        >
          Ride section
        </NavLink>
      </MemoryRouter>,
    );

    const root = screen.getByRole('link', { name: 'Rides' });
    expect(root.className).toBe('inactive');
    expect(root.hasAttribute('aria-current')).toBe(false);

    const rides = screen.getByRole('link', { name: 'Ride section' });
    expect(rides.className).toBe('active');
    expect(rides.getAttribute('aria-current')).toBe('page');
    expect(rides.getAttribute('aria-describedby')).toBe('ride-hint');
  });

  it('renders nothing when no route matches', () => {
    const view = render(
      <MemoryRouter initialEntries={['/unknown']}>
        <Routes>
          <Route path="/" element={<p>Ride library</p>} />
        </Routes>
      </MemoryRouter>,
    );

    expect(view.container.textContent).toBe('');
  });
});

describe('BrowserRouter', () => {
  it('intercepts plain internal clicks but leaves modified clicks to the browser', () => {
    render(
      <BrowserRouter>
        <Link to="/import">Import</Link>
        <Routes>
          <Route path="/" element={<p>Ride library</p>} />
          <Route path="/import" element={<p>Import rides</p>} />
        </Routes>
      </BrowserRouter>,
    );

    const link = screen.getByRole('link', { name: 'Import' });
    const pushState = vi.spyOn(window.history, 'pushState');
    expect(fireEvent.click(link, { ctrlKey: true })).toBe(true);
    expect(pushState).not.toHaveBeenCalled();
    expect(screen.getByText('Ride library')).toBeTruthy();

    window.history.replaceState(null, '', '/');
    expect(fireEvent.click(link)).toBe(false);
    expect(pushState).toHaveBeenCalledOnce();
    expect(window.location.pathname).toBe('/import');
    expect(screen.getByText('Import rides')).toBeTruthy();
  });

  it('updates matching routes when browser history emits popstate', () => {
    render(
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<p>Ride library</p>} />
          <Route path="/rides/:id" element={<RideRoute />} />
        </Routes>
      </BrowserRouter>,
    );

    expect(screen.getByText('Ride library')).toBeTruthy();
    window.history.pushState(null, '', '/rides/73');
    act(() => window.dispatchEvent(new PopStateEvent('popstate')));
    expect(screen.getByText('Ride 73')).toBeTruthy();
  });
});
