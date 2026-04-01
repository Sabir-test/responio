import { MessageSquare } from 'lucide-react';

export function ConversationsPage() {
  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Conversations</h1>
        <p className="text-gray-500 text-sm mt-1">Manage all customer conversations across channels.</p>
      </div>

      <div className="bg-white border border-dashed border-gray-300 rounded-xl p-16 text-center">
        <MessageSquare className="w-12 h-12 text-gray-200 mx-auto mb-4" />
        <p className="text-gray-500 font-medium">Conversations inbox coming soon</p>
        <p className="text-gray-400 text-sm mt-2 max-w-md mx-auto">
          The conversation inbox is powered by the Chatwoot fork (<code className="text-xs bg-gray-100 px-1 py-0.5 rounded">services/inbox/</code>),
          which is currently being initialized. WhatsApp inbound webhook is already live.
        </p>
      </div>
    </div>
  );
}
