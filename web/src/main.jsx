import React from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter, RouterProvider } from 'react-router-dom';
import './styles.css';
import App from './App.jsx';
import Home from './pages/Home.jsx';
import Project from './pages/Project.jsx';
import TaskDetail from './pages/TaskDetail.jsx';
import TaskLog from './pages/TaskLog.jsx';

const router = createBrowserRouter([
  {
    path: '/',
    element: <App />,
    children: [
      { index: true, element: <Home /> },
      { path: 'projects/:projectId', element: <Project /> },
      { path: 'tasks/:taskId', element: <TaskDetail /> },
      { path: 'tasks/:taskId/log', element: <TaskLog /> },
    ],
  },
]);

createRoot(document.getElementById('root')).render(<RouterProvider router={router} />);
