import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import ChatAssistant from '@/components/ChatAssistant';
import UpgradeButton from '@/components/UpgradeButton';
import { requireUser } from '@/lib/supabase/server';
import { updateProfile } from './actions';
import TodoList, { type Todo } from './TodoList';

export const metadata: Metadata = { title: 'Dashboard' };

interface Note {
  id: number;
  content: string;
}

export default async function Dashboard() {
  const { supabase, user } = await requireUser();
  if (!user) redirect('/login');

  // Server client + RLS: these queries can only ever return the signed-in user's rows.
  const [todosResult, notesResult] = await Promise.all([
    supabase.from('todos').select('id, title, done').order('created_at'),
    supabase.from('notes').select('id, content').order('created_at'),
  ]);
  const todos = (todosResult.data ?? []) as Todo[];
  const notes = (notesResult.data ?? []) as Note[];

  return (
    <main style={{ maxWidth: 720, margin: '40px auto', padding: 24 }}>
      <h1>Dashboard</h1>
      <UpgradeButton />

      <TodoList initialTodos={todos} />

      <section>
        <h2>Notes</h2>
        {notes.map((note) => (
          // Rendered as text: React escapes it, so stored HTML/JS cannot execute.
          <p key={note.id} style={{ whiteSpace: 'pre-wrap' }}>
            {note.content}
          </p>
        ))}
      </section>

      <form action={updateProfile}>
        <input name="full_name" placeholder="Your name" maxLength={100} required />
        <button type="submit">Save profile</button>
      </form>

      <ChatAssistant todos={todos.map((t) => t.title)} />
    </main>
  );
}
