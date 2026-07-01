import {
  BrowserRouter,
  Routes,
  Route,
  NavLink,
  Navigate,
} from 'react-router-dom';
import { cn } from '@/lib/utils';
import { WebSocketProvider } from '@/hooks/use-websocket';
import { AuthProvider, useAuth } from '@/hooks/use-auth';
import TopologyPage from '@/pages/topology';
import SessionsPage from '@/pages/sessions';
import SessionDetailPage from '@/pages/session-detail';
import PersonasPage from '@/pages/personas';
import SkillsPage from '@/pages/skills';
import WikiPage from '@/pages/wiki';
import LoginPage from '@/pages/login';

const navItems = [
  { to: '/', label: 'Topology', icon: '◉' },
  { to: '/sessions', label: 'Sessions', icon: '◎' },
  { to: '/personas', label: 'Personas', icon: '◌' },
  { to: '/skills', label: 'Skills', icon: '⚙' },
  { to: '/wiki', label: 'Wiki', icon: '◈' },
];

function AppLayout() {
  const { isAuthenticated } = useAuth();

  if (!isAuthenticated) {
    return <LoginPage />;
  }

  return (
    <div className="flex h-screen">
      {/* Sidebar */}
      <aside className="w-56 border-r bg-sidebar-background text-sidebar-foreground flex flex-col">
        <div className="p-4 border-b border-sidebar-border">
          <h1 className="font-semibold text-lg">Drone Coordinator</h1>
          <p className="text-xs text-sidebar-foreground/60 mt-0.5">
            Swarm Control Plane
          </p>
        </div>
        <nav className="flex-1 p-2 space-y-1">
          {navItems.map(item => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === '/'}
              className={({ isActive }) =>
                cn(
                  'flex items-center gap-3 px-3 py-2 rounded-md text-sm transition-colors',
                  isActive
                    ? 'bg-sidebar-accent text-sidebar-accent-foreground font-medium'
                    : 'hover:bg-sidebar-accent/50 text-sidebar-foreground/80'
                )
              }
            >
              <span className="text-base">{item.icon}</span>
              {item.label}
            </NavLink>
          ))}
        </nav>
        <div className="p-3 border-t border-sidebar-border text-xs text-sidebar-foreground/40">
          v1.0.0
        </div>
      </aside>

      {/* Main content */}
      <main className="flex-1 overflow-auto p-6">
        <Routes>
          <Route path="/" element={<TopologyPage />} />
          <Route path="/sessions" element={<SessionsPage />} />
          <Route path="/sessions/:sessionId" element={<SessionDetailPage />} />
          <Route path="/personas" element={<PersonasPage />} />
          <Route path="/skills" element={<SkillsPage />} />
          <Route path="/wiki" element={<WikiPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <WebSocketProvider>
        <BrowserRouter>
          <AppLayout />
        </BrowserRouter>
      </WebSocketProvider>
    </AuthProvider>
  );
}
