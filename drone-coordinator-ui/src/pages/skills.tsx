import { useEffect, useState } from 'react';
import { useAuthenticatedFetch } from '@/hooks/use-auth';
import type { Skill } from '@/lib/types';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';

export default function SkillsPage() {
  const authFetch = useAuthenticatedFetch();
  const [skills, setSkills] = useState<Skill[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function fetchSkills() {
      try {
        const res = await authFetch('/skills');
        if (res.ok) {
          setSkills(await res.json());
        }
      } catch {
        // Handle error
      } finally {
        setLoading(false);
      }
    }
    fetchSkills();
  }, [authFetch]);

  if (loading) {
    return (
      <div>
        <h1 className="text-2xl font-bold mb-6">Skills</h1>
        <p className="text-muted-foreground">Loading...</p>
      </div>
    );
  }

  return (
    <div>
      <h1 className="text-2xl font-bold mb-1">Skills</h1>
      <p className="text-muted-foreground text-sm mb-6">
        Swarm-wide skill definitions
      </p>

      {skills.length === 0 ? (
        <div className="text-center py-12 text-muted-foreground">
          <p className="text-lg">No skills defined</p>
          <p className="text-sm mt-1">
            Skills define reusable capabilities available to agents across the
            swarm.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {skills.map(skill => (
            <Card key={skill.id}>
              <CardHeader className="pb-2">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-lg">{skill.name}</CardTitle>
                  <Badge variant="outline" className="text-xs">
                    {skill.scope}
                  </Badge>
                </div>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-muted-foreground mb-3">
                  {skill.description}
                </p>
                <div className="text-xs text-muted-foreground space-y-1">
                  <div className="flex justify-between">
                    <span>ID</span>
                    <span className="font-mono">{skill.id}</span>
                  </div>
                  <div className="flex justify-between">
                    <span>Trigger</span>
                    <span className="font-mono">{skill.trigger}</span>
                  </div>
                  <div className="flex justify-between">
                    <span>Updated</span>
                    <span>
                      {new Date(skill.updatedAt).toLocaleDateString()}
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
