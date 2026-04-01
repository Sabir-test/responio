import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { GitFork, Plus, Play, Pause, Trash2, Clock } from 'lucide-react';
import { workflowsApi, type WorkflowSummary } from '../lib/api-client';

export function WorkflowsPage() {
  const qc = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ['workflows'],
    queryFn: () => workflowsApi.list(),
  });

  const publishMutation = useMutation({
    mutationFn: (id: string) => workflowsApi.publish(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['workflows'] }),
  });

  const unpublishMutation = useMutation({
    mutationFn: (id: string) => workflowsApi.unpublish(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['workflows'] }),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => workflowsApi.delete(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['workflows'] }),
  });

  const workflows = data?.data ?? [];

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Workflows</h1>
          <p className="text-gray-500 text-sm mt-1">Automate conversations and contact lifecycle actions.</p>
        </div>
        <button
          className="flex items-center gap-2 px-4 py-2 bg-brand-600 text-white text-sm font-medium rounded-lg hover:bg-brand-700 transition-colors"
          onClick={() => alert('Workflow builder (React Flow) coming in Phase 2')}
        >
          <Plus className="w-4 h-4" />
          New Workflow
        </button>
      </div>

      {isLoading ? (
        <div className="space-y-3">
          {[...Array(3)].map((_, i) => (
            <div key={i} className="bg-white border border-gray-200 rounded-xl p-4 animate-pulse h-16" />
          ))}
        </div>
      ) : workflows.length === 0 ? (
        <div className="bg-white border border-dashed border-gray-300 rounded-xl p-12 text-center">
          <GitFork className="w-10 h-10 text-gray-300 mx-auto mb-3" />
          <p className="text-gray-500 font-medium">No workflows yet</p>
          <p className="text-gray-400 text-sm mt-1">Create your first workflow to start automating.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {workflows.map((wf: WorkflowSummary) => (
            <WorkflowRow
              key={wf.id}
              workflow={wf}
              onPublish={() => publishMutation.mutate(wf.id)}
              onUnpublish={() => unpublishMutation.mutate(wf.id)}
              onDelete={() => {
                if (confirm(`Delete "${wf.name}"?`)) deleteMutation.mutate(wf.id);
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function WorkflowRow({
  workflow,
  onPublish,
  onUnpublish,
  onDelete,
}: {
  workflow: WorkflowSummary;
  onPublish: () => void;
  onUnpublish: () => void;
  onDelete: () => void;
}) {
  const isPublished = workflow.status === 'published';

  return (
    <div className="bg-white border border-gray-200 rounded-xl px-5 py-4 flex items-center gap-4">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="font-medium text-gray-900 truncate">{workflow.name}</span>
          <span
            className={`text-xs px-2 py-0.5 rounded-full font-medium ${
              isPublished
                ? 'bg-green-100 text-green-700'
                : 'bg-gray-100 text-gray-600'
            }`}
          >
            {workflow.status}
          </span>
          <span className="text-xs text-gray-400">v{workflow.version}</span>
        </div>
        <div className="flex items-center gap-1 mt-0.5">
          <Clock className="w-3 h-3 text-gray-400" />
          <span className="text-xs text-gray-400">{workflow.trigger_type.replace(/_/g, ' ')}</span>
        </div>
      </div>

      <div className="flex items-center gap-2">
        {isPublished ? (
          <button
            onClick={onUnpublish}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-amber-700 bg-amber-50 hover:bg-amber-100 rounded-lg transition-colors"
          >
            <Pause className="w-3.5 h-3.5" />
            Pause
          </button>
        ) : (
          <button
            onClick={onPublish}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-green-700 bg-green-50 hover:bg-green-100 rounded-lg transition-colors"
          >
            <Play className="w-3.5 h-3.5" />
            Publish
          </button>
        )}
        <button
          onClick={onDelete}
          className="p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors"
          aria-label="Delete"
        >
          <Trash2 className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}
