import { Users } from 'lucide-react';

export function ContactsPage() {
  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Contacts</h1>
        <p className="text-gray-500 text-sm mt-1">View and manage your contact database.</p>
      </div>

      <div className="bg-white border border-dashed border-gray-300 rounded-xl p-16 text-center">
        <Users className="w-12 h-12 text-gray-200 mx-auto mb-4" />
        <p className="text-gray-500 font-medium">Contacts coming soon</p>
        <p className="text-gray-400 text-sm mt-2 max-w-md mx-auto">
          Contact management will be available once the Chatwoot inbox service is initialized.
          Contact schema and RLS policies are already configured in PostgreSQL.
        </p>
      </div>
    </div>
  );
}
