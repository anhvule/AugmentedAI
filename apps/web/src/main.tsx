import { createRoot } from 'react-dom/client';
import { createBrowserRouter, RouterProvider } from 'react-router-dom';
import './styles.css';
import App from './App';
import Home from './pages/Home';
import Project from './pages/Project';
import TaskDetail from './pages/TaskDetail';
import TaskLog from './pages/TaskLog';
import Chat from './pages/Chat';

const router = createBrowserRouter([
  {
    path: '/',
    element: <App />,
    children: [
      { index: true, element: <Home /> },
      { path: 'projects/:projectId', element: <Project /> },
      { path: 'tasks/:taskId', element: <TaskDetail /> },
      { path: 'tasks/:taskId/log', element: <TaskLog /> },
      { path: 'chat', element: <Chat /> },
    ],
  },
]);

createRoot(document.getElementById('root')!).render(<RouterProvider router={router} />);
