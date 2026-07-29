import { NavLink, Route, Routes } from 'react-router-dom';
import { Library } from './pages/Library.tsx';
import { RideDetail } from './pages/RideDetail.tsx';
import { ImportPage } from './pages/Import.tsx';
import { Trends } from './pages/Trends.tsx';
import { SettingsPage } from './pages/Settings.tsx';
import { LogoMark } from './components/ui.tsx';

const NAV = [
  { to: '/', label: 'Rides', icon: <IconRides /> },
  { to: '/trends', label: 'Trends', icon: <IconTrends /> },
  { to: '/import', label: 'Import', icon: <IconImport /> },
  { to: '/settings', label: 'Settings', icon: <IconSettings /> },
];

export function App() {
  return (
    <div className="shell">
      <nav className="sidebar" aria-label="Main">
        <div className="brand">
          <LogoMark />
          <span className="brand-word">Velograph</span>
        </div>
        {NAV.map((n) => (
          <NavLink
            key={n.to}
            to={n.to}
            end={n.to === '/'}
            className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}
          >
            {n.icon}
            <span className="nav-label">{n.label}</span>
          </NavLink>
        ))}
        <div className="sidebar-foot">
          Local-first · Offline
          <br />
          v0.1.0
        </div>
      </nav>
      <main className="main">
        <Routes>
          <Route path="/" element={<Library />} />
          <Route path="/rides/:id" element={<RideDetail />} />
          <Route path="/trends" element={<Trends />} />
          <Route path="/import" element={<ImportPage />} />
          <Route path="/settings" element={<SettingsPage />} />
        </Routes>
      </main>
    </div>
  );
}

const stroke = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.6,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
} as const;

function IconRides() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="6" cy="17" r="4" {...stroke} />
      <circle cx="18" cy="17" r="4" {...stroke} />
      <path d="M6 17 10 8h5l3 9M10 8 8 5h3" {...stroke} />
    </svg>
  );
}

function IconTrends() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 19V5M4 19h16" {...stroke} />
      <path d="m7 14 4-5 3 3 5-7" {...stroke} />
    </svg>
  );
}

function IconImport() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 4v10m0 0 4-4m-4 4-4-4M4 19h16" {...stroke} />
    </svg>
  );
}

function IconSettings() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="3" {...stroke} />
      <path
        d="M12 3v3m0 12v3M3 12h3m12 0h3M5.6 5.6l2.1 2.1m8.6 8.6 2.1 2.1m0-12.8-2.1 2.1M7.7 16.3l-2.1 2.1"
        {...stroke}
      />
    </svg>
  );
}
