import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useAuthenticatedFetch } from '@/hooks/use-auth';
import type { Persona, CreatePersonaRequest } from '@/lib/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';

export default function PersonaEditorPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const authFetch = useAuthenticatedFetch();
  const isEdit = !!id;

  const [loading, setLoading] = useState(isEdit);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [name, setName] = useState('');
  const [personaId, setPersonaId] = useState('');
  const [description, setDescription] = useState('');
  const [scope, setScope] = useState('coordinator');
  const [systemPrompt, setSystemPrompt] = useState('');

  // Load existing persona for edit mode
  useEffect(() => {
    if (!id) return;

    async function fetchPersona() {
      try {
        const res = await authFetch(`/api/personas/${id}`);
        if (res.ok) {
          const p: Persona = await res.json();
          setName(p.name);
          setPersonaId(p.id);
          setDescription(p.description);
          setScope(p.scope);
          setSystemPrompt(p.systemPrompt);
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

  // Auto-generate ID from name on create
  const handleNameChange = (value: string) => {
    setName(value);
    if (!isEdit) {
      setPersonaId(
        value
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-|-$/g, '')
      );
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!name.trim()) {
      setError('Name is required');
      return;
    }
    if (!personaId.trim()) {
      setError('ID is required');
      return;
    }
    if (!description.trim()) {
      setError('Description is required');
      return;
    }
    if (!systemPrompt.trim()) {
      setError('System prompt is required');
      return;
    }

    setSaving(true);
    try {
      const body: CreatePersonaRequest = {
        id: personaId.trim(),
        name: name.trim(),
        description: description.trim(),
        systemPrompt: systemPrompt.trim(),
        scope,
      };

      if (isEdit) {
        const res = await authFetch(`/api/personas/${id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (res.ok) {
          navigate(`/personas/${id}`);
        } else {
          const data = await res.json().catch(() => ({}));
          setError(data.error || 'Failed to update persona');
        }
      } else {
        const res = await authFetch('/api/personas', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (res.ok) {
          const created = await res.json();
          navigate(`/personas/${created.id}`);
        } else {
          const data = await res.json().catch(() => ({}));
          setError(data.error || 'Failed to create persona');
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Network error');
    } finally {
      setSaving(false);
    }
  };

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
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-64 w-full" />
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
        <div>
          <h1 className="text-2xl font-bold">
            {isEdit ? 'Edit Persona' : 'New Persona'}
          </h1>
          <p className="text-muted-foreground text-sm mt-1">
            {isEdit ? `Editing "${name}"` : 'Create a new swarm-wide persona'}
          </p>
        </div>
      </div>

      {error && (
        <div className="mb-4 p-3 rounded-md bg-destructive/10 text-destructive text-sm">
          {error}
        </div>
      )}

      <form onSubmit={handleSubmit} className="max-w-2xl space-y-4">
        <div>
          <label htmlFor="name" className="block text-sm font-medium mb-1">
            Name *
          </label>
          <Input
            id="name"
            value={name}
            onChange={e => handleNameChange(e.target.value)}
            placeholder="My Persona"
          />
        </div>

        <div>
          <label
            htmlFor="persona-id"
            className="block text-sm font-medium mb-1"
          >
            ID *
          </label>
          <Input
            id="persona-id"
            value={personaId}
            onChange={e => setPersonaId(e.target.value)}
            placeholder="my-persona"
            disabled={isEdit}
            className={isEdit ? 'opacity-50' : ''}
          />
          <p className="text-xs text-muted-foreground mt-1">
            URL-safe identifier. Auto-generated from name on create.
          </p>
        </div>

        <div>
          <label
            htmlFor="description"
            className="block text-sm font-medium mb-1"
          >
            Description *
          </label>
          <textarea
            id="description"
            value={description}
            onChange={e => setDescription(e.target.value)}
            placeholder="Describe what this persona does..."
            className="w-full px-3 py-2 border rounded-md text-sm bg-background min-h-[60px]"
          />
        </div>

        <div>
          <label htmlFor="scope" className="block text-sm font-medium mb-1">
            Scope
          </label>
          <select
            id="scope"
            value={scope}
            onChange={e => setScope(e.target.value)}
            className="w-full px-3 py-2 border rounded-md text-sm bg-background"
          >
            <option value="coordinator">coordinator</option>
          </select>
        </div>

        <div>
          <label
            htmlFor="system-prompt"
            className="block text-sm font-medium mb-1"
          >
            System Prompt *
          </label>
          <textarea
            id="system-prompt"
            value={systemPrompt}
            onChange={e => setSystemPrompt(e.target.value)}
            placeholder="Enter the system prompt for this persona..."
            className="w-full px-3 py-2 border rounded-md text-sm bg-background min-h-[300px] font-mono"
          />
        </div>

        <div className="flex gap-3 pt-2">
          <Button type="submit" disabled={saving}>
            {saving ? 'Saving...' : isEdit ? 'Save Changes' : 'Create Persona'}
          </Button>
          <Button type="button" variant="outline" onClick={() => navigate(-1)}>
            Cancel
          </Button>
        </div>
      </form>
    </div>
  );
}
