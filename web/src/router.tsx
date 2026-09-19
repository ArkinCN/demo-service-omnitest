import { createBrowserRouter, Navigate } from 'react-router'
import { FlowScreen } from './app/FlowScreen'
import { Shell } from './app/Shell'
import { FLOWS } from './data/flows'
import './features'

export const router = createBrowserRouter([
  {
    path: '/',
    element: <Shell />,
    children: [
      { index: true, element: <Navigate to="/init" replace /> },
      ...FLOWS.map((f) => ({
        path: f.path.slice(1),
        element: <FlowScreen flow={f.id} />,
      })),
      { path: '*', element: <Navigate to="/init" replace /> },
    ],
  },
])
