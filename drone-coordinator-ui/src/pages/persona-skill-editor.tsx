import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useAuthenticatedFetch } from '@/hooks/use-auth';
import type { Skill, CreateSkillRequest } from '@/lib/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorBanner } from '@/components/error-banner';

export default function PersonaSkillEditorPage() {
  const { id, skillId } = useParams<{ id: string; skillId?: string }>();
  const navigate = useNavigate();
  const authFetch = useAuthenticatedFetch();
  const isEdit = !!skillId;

  const [loading, setLoading] = useState(isEdit);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [name, setName] = useState('');
  const [newSkillId, setNewSkillId] = useState('');
  const [description, setDescription] = useState('');
  const [trigger, setTrigger] = useState('');
  const [body, setBody] = useState('');

  useEffect(() => {
    if (!id || !skillId) return;

    async function fetchSkill() {
      try {
        const res = await authFetch(`/api/personas/${id}/skills/${skillId}`);
        if (res.ok) {
          const s: Skill = await res.json();
          setName(s.name);
          setNewSkillId(s.id);
          setDescription(s.description);
          setTrigger(s.trigger);
          setBody(s.body);
        } else {
          setError('Skill not found');
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load skill');
      } finally {
        setLoading(false);
      }
    }
    fetchSkill();
  }, [id, skillId, authFetch]);

  const handleNameChange = (value: string) => {
    setName(value);
    if (!isEdit) {
      setNewSkillId(
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
    if (!newSkillId.trim()) {
      setError('ID is required');
      return;
    }
    if (!description.trim()) {
      setError('Description is required');
      return;
    }
    if (!body.trim()) {
      setError('Body is required');
      return;
    }

    setSaving(true);
    try {
      const payload: CreateSkillRequest = {
        id: newSkillId.trim(),
        name: name.trim(),
        description: description.trim(),
        trigger: trigger.trim(),
        body: body.trim(),
      };

      const res = isEdit
        ? await authFetch(`/api/personas/${id}/skills/${skillId}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          })
        : await authFetch(`/api/personas/${id}/skills`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          });

      if (res.ok) {
        navigate(`/personas/${id}`);
      } else {
        const data = await res.json().catch(() => ({}));
        setError(
          data.error || (isEdit ? 'Failed to update skill' : 'Failed to create skill')
        );
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Network error');
    } finally {
      setSaving(false);
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
            {isEdit ? 'Edit Owned Skill' : 'New Owned Skill'}
          </h1>
          <p className="text-muted-foreground text-sm mt-1">
            {isEdit
              ? `Editing "${name}"`
              : `A skill owned by persona "${id}"`}
          </p>
        </div>
      </div>

      <ErrorBanner message={error} />

      <form onSubmit={handleSubmit} className="max-w-2xl space-y-4">
        <div>
          <label htmlFor="name" className="block text-sm font-medium mb-1">
            Name *
          </label>
          <Input
            id="name"
            value={name}
            onChange={e => handleNameChange(e.target.value)}
            placeholder="My Skill"
          />
        </div>

        <div>
          <label htmlFor="skill-id" className="block text-sm font-medium mb-1">
            ID *
          </label>
          <Input
            id="skill-id"
            value={newSkillId}
            onChange={e => setNewSkillId(e.target.value)}
            placeholder="my-skill"
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
            placeholder="Describe what this skill does..."
            className="w-full px-3 py-2 border rounded-md text-sm bg-background min-h-[60px]"
          />
        </div>

        <div>
          <label htmlFor="trigger" className="block text-sm font-medium mb-1">
            Trigger
          </label>
          <textarea
            id="trigger"
            value={trigger}
            onChange={e => setTrigger(e.target.value)}
            placeholder="When should this skill be recalled? (e.g., 'the user asks about X')"
            className="w-full px-3 py-2 border rounded-md text-sm bg-background min-h-[60px]"
          />
        </div>

        <div>
          <label htmlFor="body" className="block text-sm font-medium mb-1">
            Body *
          </label>
          <textarea
            id="body"
            value={body}
            onChange={e => setBody(e.target.value)}
            placeholder="Enter the skill body (markdown)..."
            className="w-full px-3 py-2 border rounded-md text-sm bg-background min-h-[300px] font-mono"
          />
        </div>

        <div className="flex gap-3 pt-2">
          <Button type="submit" disabled={saving}>
            {saving ? 'Saving...' : isEdit ? 'Save Changes' : 'Create Skill'}
          </Button>
          <Button type="button" variant="outline" onClick={() => navigate(-1)}>
            Cancel
          </Button>
        </div>
      </form>
    </div>
  );
}
