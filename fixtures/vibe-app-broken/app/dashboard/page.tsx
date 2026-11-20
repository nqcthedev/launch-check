'use client';

import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import ChatAssistant from '@/components/ChatAssistant';
import UpgradeButton from '@/components/UpgradeButton';
import { updateProfile } from './actions';

export default function Dashboard() {
  const [todos, setTodos] = useState<any[]>([]);
  const [notes, setNotes] = useState<any[]>([]);
  const [title, setTitle] = useState('');

  useEffect(() => {
    loadData();
  }, []);

  async function loadData() {
    const { data: todoData } = await supabase.from('todos').select('*').order('created_at');
    const { data: noteData } = await supabase.from('notes').select('*');
    console.log('loaded data', todoData, noteData);
    setTodos(todoData || []);
    setNotes(noteData || []);
  }

  async function addTodo() {
    const { data, error } = await supabase.from('todos').insert({ title }).select();
    console.log('insert result', data, error);
    setTitle('');
    loadData();
  }

  async function deleteTodo(id: number) {
    await fetch(`/api/todos/${id}`, { method: 'DELETE' });
    loadData();
  }

  return (
    <main style={{ maxWidth: 720, margin: '40px auto', padding: 24 }}>
      <h1>Dashboard</h1>
      <UpgradeButton userId={todos[0]?.user_id} />

      <section>
        <h2>Todos</h2>
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="New todo" />
        <button onClick={addTodo}>Add</button>
        <ul>
          {todos.map((todo: any) => (
            <li key={todo.id}>
              {todo.title} <button onClick={() => deleteTodo(todo.id)}>Delete</button>
            </li>
          ))}
        </ul>
      </section>

      <section>
        <h2>Notes</h2>
        {notes.map((note: any) => (
          <div key={note.id} dangerouslySetInnerHTML={{ __html: note.content }} />
        ))}
      </section>

      <form action={updateProfile}>
        <input name="full_name" placeholder="Your name" />
        <button type="submit">Save profile</button>
      </form>

      <ChatAssistant todos={todos} />
    </main>
  );
}
