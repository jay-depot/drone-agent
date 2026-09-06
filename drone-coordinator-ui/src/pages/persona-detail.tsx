import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useAuthenticatedFetch } from '@/hooks/use-auth';
import type { Persona } from '@/lib/types';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';

export default function PersonaDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const authFetch = useAuthenticatedFetch();
  const [persona, setPersona] = useState<Persona | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteLoading, setDeleteLoading] = useState(false);

  useEffect(() => {
    if (!id) return;

    async function fetchPersona() {
      setLoading(true);
      setError(null);
      try {
        const res = await authFetch(`/api/personas/${id}`);
        if (res.ok) {
          setPersona(await res.json());
        } else {
          setError('Persona not found');
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load persona');
      } finally {
        setLoading(false);
      }
    }
    fetchPersona();
  }, [id, authFetch]);

  const handleDelete = async () => {
    if (!id) return;
    setDeleteLoading(true);
    try {
      const res = await authFetch(`/api/personas/${id}`, { method: 'DELETE' });
      if (res.ok) {
        navigate('/personas');
      }
    } catch {
      // Error handled silently
    } finally {
      setDeleteLoading(false);
    }
  };

  if (!id) {
    return (
      <div className="text-center py-12 text-muted-foreground">
        No persona ID provided.
      </div>
    );
  }

  if (loading) {
    return (
      <div>
        <div className="flex items-center gap-4 mb-6">
          <Button variant="outline" size="sm" onClick={() => navigate(-1)}>
            ← Back
          </Button>
          <Skeleton className="h-8 w-48" />
        </div>
        <div className="space-y-4">
          <Skeleton className="h-32 w-full" />
          <Skeleton className="h-64 w-full" />
        </div>
      </div>
    );
  }

  if (error || !persona) {
    return (
      <div>
        <div className="flex items-center gap-4 mb-6">
          <Button variant="outline" size="sm" onClick={() => navigate(-1)}>
            ← Back
          </Button>
        </div>
        <div className="text-center py-12 text-muted-foreground">
          <p className="text-lg">{error || 'Persona not found'}</p>
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center gap-4 mb-6">
        <Button variant="outline" size="sm" onClick={() => navigate(-1)}>
          ← Back
        </Button>
        <div className="flex-1">
          <h1 className="text-2xl font-bold">{persona.name}</h1>
          <p className="text-muted-foreground text-sm mt-1 font-mono">
            {persona.id}
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            onClick={() => navigate(`/personas/${id}/edit`)}
          >
            Edit
          </Button>
          <Button variant="destructive" onClick={() => setDeleteOpen(true)}>
            Delete
          </Button>
        </div>
      </div>

      {/* Info Card */}
      <Card className="mb-6">
        <CardHeader>
          <CardTitle className="text-base">Information</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 gap-4 text-sm">
            <div>
              <span className="text-muted-foreground">Scope</span>
              <p className="mt-0.5">
                <Badge variant="outline" className="text-xs">
                  {persona.scope}
                </Badge>
              </p>
            </div>
            <div>
              <span className="text-muted-foreground">Description</span>
              <p className="mt-0.5">{persona.description}</p>
            </div>
            <div>
              <span className="text-muted-foreground">Created</span>
              <p className="mt-0.5">
                {new Date(persona.createdAt).toLocaleString()}
              </p>
            </div>
            <div>
              <span className="text-muted-foreground">Updated</span>
              <p className="mt-0.5">
                {new Date(persona.updatedAt).toLocaleString()}
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* System Prompt */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">System Prompt</CardTitle>
        </CardHeader>
        <CardContent>
          <pre className="text-xs bg-muted p-4 rounded-md overflow-x-auto whitespace-pre-wrap font-mono">
            {persona.systemPrompt}
          </pre>
        </CardContent>
      </Card>

      {/* Delete Confirmation */}
      <Dialog
        open={deleteOpen}
        onClose={() => setDeleteOpen(false)}
        onConfirm={handleDelete}
        title="Delete Persona"
        description={`Are you sure you want to delete "${persona.name}"? This action cannot be undone.`}
        confirmLabel="Delete"
        variant="destructive"
        loading={deleteLoading}
      />
    </div>
  );
}
