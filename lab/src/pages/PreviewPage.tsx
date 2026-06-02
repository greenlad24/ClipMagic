// This page now redirects to the Timeline Editor.
// The redirect is handled in App.tsx via the PreviewRedirect component.
// This file is kept for compatibility with any direct imports.
import { useParams, Navigate } from 'react-router-dom';

export default function PreviewPage() {
  const { id } = useParams<{ id: string }>();
  return <Navigate to={`/project/${id}/timeline`} replace />;
}
