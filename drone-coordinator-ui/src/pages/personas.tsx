import { useEffect, useState } from 'react';
import type { Persona } from '@/lib/types';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';

export default function PersonasPage() {
  const [personas, setPersonas] = useState<Persona[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function fetchPersonas() {
      try {
        const res = await fetch('/personas');
        if (res.ok) {
          setPersonas(await res.json());
        }
      } catch {
        // Handle error
      } finally {
        setLoading(false);
      }
    }
    fetchPersonas();
  }, []);

  if (loading) {
    return (
      <div>
        <h1 className="text-2xl font-bold mb-6">Personas</h1>
        <p className="text-muted-foreground">Loading...</p>
      </div>
    );
  }

  return (
    <div>
      <h1 className="text-2xl font-bold mb-1">Personas</h1>
      <p className="text-muted-foreground text-sm mb-6">
        Swarm-wide persona definitions
      </p>

      {personas.length === 0 ? (
        <div className="text-center py-12 text-muted-foreground">
          <p className="text-lg">No personas defined</p>
          <p className="text-sm mt-1">
            Personas define agent identities and behaviors across the swarm.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {personas.map(persona => (
            <Card key={persona.id}>
              <CardHeader className="pb-2">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-lg">{persona.name}</CardTitle>
                  <Badge variant="outline" className="text-xs">
                    {persona.scope}
                  </Badge>
                </div>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-muted-foreground mb-3">
                  {persona.description}
                </p>
                <div className="text-xs text-muted-foreground space-y-1">
                  <div className="flex justify-between">
                    <span>ID</span>
                    <span className="font-mono">{persona.id}</span>
                  </div>
                  <div className="flex justify-between">
                    <span>Updated</span>
                    <span>
                      {new Date(persona.updatedAt).toLocaleDateString()}
                    </span>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
