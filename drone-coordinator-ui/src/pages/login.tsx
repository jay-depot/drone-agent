import { useState } from 'react';
import { useAuth } from '@/hooks/use-auth';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';

export default function LoginPage() {
  const { setToken } = useAuth();
  const [inputValue, setInputValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = inputValue.trim();
    if (!trimmed) return;

    setLoading(true);
    setError(null);

    try {
      // Validate the token against a protected API endpoint (not /health,
      // which is auth-exempt and answers 200 to any token). A wrong token
      // 401s here and fails at the gate.
      const res = await fetch('/api/personas', {
        headers: { Authorization: `Bearer ${trimmed}` },
      });

      if (res.status === 401) {
        setError('Invalid token. Please try again.');
      } else if (res.ok) {
        setToken(trimmed);
      } else {
        // Other statuses (429/5xx) mean the server answered but we can't
        // confirm rejection — keep the permissive fallback and let the app
        // handle any 401 later.
        setToken(trimmed);
      }
    } catch {
      // Network error — still store the token and let the app try
      setToken(trimmed);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex items-center justify-center min-h-screen bg-background">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <CardTitle className="text-xl">Drone Coordinator</CardTitle>
          <p className="text-sm text-muted-foreground mt-1">
            Enter your web access token to continue
          </p>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <input
                type="password"
                value={inputValue}
                onChange={e => setInputValue(e.target.value)}
                placeholder="Paste your access token..."
                className="w-full px-3 py-2 border rounded-md text-sm bg-background"
                autoFocus
              />
              {error && <p className="text-red-500 text-xs mt-1.5">{error}</p>}
            </div>
            <Button
              type="submit"
              className="w-full"
              disabled={loading || !inputValue.trim()}
            >
              {loading ? 'Verifying...' : 'Connect'}
            </Button>
          </form>
          <p className="text-xs text-muted-foreground mt-4 text-center">
            Run{' '}
            <code className="bg-muted px-1 rounded">
              drone-coordinator --show-web-token
            </code>{' '}
            on the coordinator host to get your token.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
