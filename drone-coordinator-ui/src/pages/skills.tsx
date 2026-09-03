import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuthenticatedFetch } from '@/hooks/use-auth';
import { usePaginationOffset } from '@/hooks/use-pagination-offset';
import type { Skill } from '@/lib/types';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog } from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { paginationRange } from '@/lib/pagination';

const PAGE_SIZE = 12;

export default function SkillsPage() {
  const navigate = useNavigate();
  const authFetch = useAuthenticatedFetch();
  const [skills, setSkills] = useState<Skill[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const { offset, setOffset } = usePaginationOffset(PAGE_SIZE);

  // Delete dialog
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Skill | null>(null);
  const [deleteLoading, setDeleteLoading] = useState(false);

  useEffect(() => {
    async function fetchSkills() {
      setLoading(true);
      setError(null);
      try {
        const res = await authFetch('/api/skills');
        if (res.ok) {
          setSkills(await res.json());
        }
      } catch {
        setError('Failed to load skills');
      } finally {
        setLoading(false);
      }
    }
    fetchSkills();
  }, [authFetch]);

  const filtered = skills.filter(s => {
    if (!search) return true;
    const q = search.toLowerCase();
    return (
      s.name.toLowerCase().includes(q) ||
      s.description.toLowerCase().includes(q) ||
      s.trigger.toLowerCase().includes(q) ||
      s.id.toLowerCase().includes(q)
    );
  });

  const total = filtered.length;
  const paged = filtered.slice(offset, offset + PAGE_SIZE);

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setDeleteLoading(true);
    try {
      const res = await authFetch(`/api/skills/${deleteTarget.id}`, {
        method: 'DELETE',
      });
      if (res.ok) {
        setSkills(prev => prev.filter(s => s.id !== deleteTarget.id));
        setDeleteOpen(false);
        setDeleteTarget(null);
      }
    } catch {
      // Error handled silently
    } finally {
      setDeleteLoading(false);
    }
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold">Skills</h1>
          <p className="text-muted-foreground text-sm mt-1">
            Swarm-wide skill definitions
          </p>
        </div>
        <Button onClick={() => navigate('/skills/new')}>New Skill</Button>
      </div>

      {error && (
        <div className="mb-4 p-3 rounded-md bg-destructive/10 text-destructive text-sm">
          {error}
        </div>
      )}

      {/* Search */}
      <div className="mb-4">
        <Input
          placeholder="Search skills..."
          value={search}
          onChange={e => {
            setSearch(e.target.value);
            setOffset(0);
          }}
        />
      </div>

      {loading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {[1, 2, 3, 4].map(i => (
            <Card key={i}>
              <CardHeader className="pb-2">
                <Skeleton className="h-5 w-32" />
              </CardHeader>
              <CardContent>
                <Skeleton className="h-4 w-full mb-2" />
                <Skeleton className="h-4 w-3/4" />
              </CardContent>
            </Card>
          ))}
        </div>
      ) : paged.length === 0 ? (
        <div className="text-center py-12 text-muted-foreground">
          <p className="text-lg">
            {search ? 'No skills match your search' : 'No skills defined'}
          </p>
          <p className="text-sm mt-1">
            {search
              ? 'Try a different search term.'
              : 'Skills define reusable capabilities available to agents across the swarm.'}
          </p>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {paged.map(skill => (
              <Card
                key={skill.id}
                className="cursor-pointer hover:ring-2 hover:ring-ring/50 transition-all"
                onClick={() => navigate(`/skills/${skill.id}`)}
              >
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
                  <div
                    className="mt-3 pt-3 border-t"
                    onClick={e => e.stopPropagation()}
                  >
                    <Button
                      variant="destructive"
                      size="sm"
                      onClick={() => {
                        setDeleteTarget(skill);
                        setDeleteOpen(true);
                      }}
                    >
                      Delete
                    </Button>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>

          {/* Pagination */}
          {total > PAGE_SIZE && (
            <div className="flex items-center justify-between mt-4">
              <p className="text-sm text-muted-foreground">
                Showing {paginationRange(offset, PAGE_SIZE, total)}
              </p>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={offset === 0}
                  onClick={() => setOffset(offset - PAGE_SIZE)}
                >
                  Previous
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={offset + PAGE_SIZE >= total}
                  onClick={() => setOffset(offset + PAGE_SIZE)}
                >
                  Next
                </Button>
              </div>
            </div>
          )}
        </>
      )}

      {/* Delete Confirmation */}
      <Dialog
        open={deleteOpen}
        onClose={() => {
          setDeleteOpen(false);
          setDeleteTarget(null);
        }}
        onConfirm={handleDelete}
        title="Delete Skill"
        description={
          deleteTarget
            ? `Are you sure you want to delete "${deleteTarget.name}"? This action cannot be undone.`
            : ''
        }
        confirmLabel="Delete"
        variant="destructive"
        loading={deleteLoading}
      />
    </div>
  );
}
