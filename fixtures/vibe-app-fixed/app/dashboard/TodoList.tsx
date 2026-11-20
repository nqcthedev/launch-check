'use client';

import { useRouter } from 'next/navigation';
import { addTodo } from './actions';

export interface Todo {
  id: number;
  title: string;
  done: boolean;
}

export default function TodoList({ initialTodos }: { initialTodos: Todo[] }) {
  const router = useRouter();

  async function deleteTodo(id: number) {
    const res = await fetch(`/api/todos/${id}`, { method: 'DELETE' });
    if (res.ok) router.refresh();
  }

  return (
    <section>
      <h2>Todos</h2>
      <form action={addTodo}>
        <input name="title" placeholder="New todo" maxLength={200} required />
        <button type="submit">Add</button>
      </form>
      <ul>
        {initialTodos.map((todo) => (
          <li key={todo.id}>
            {todo.title} <button onClick={() => deleteTodo(todo.id)}>Delete</button>
          </li>
        ))}
      </ul>
    </section>
  );
}
