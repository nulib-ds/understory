import process from 'node:process';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  return {
    plugins: [react()],
    define: {
      'import.meta.env.VITE_IIIF_BASE_URL': JSON.stringify(env.VITE_IIIF_BASE_URL || ''),
      'import.meta.env.VITE_MANIFEST_API_URL': JSON.stringify(env.VITE_MANIFEST_API_URL || ''),
      'import.meta.env.VITE_COLLECTION_API_URL': JSON.stringify(env.VITE_COLLECTION_API_URL || ''),
      'import.meta.env.VITE_STORAGE_BUCKET': JSON.stringify(env.VITE_STORAGE_BUCKET || ''),
      'import.meta.env.VITE_SOURCE_BUCKET': JSON.stringify(env.VITE_SOURCE_BUCKET || ''),
      'import.meta.env.VITE_STORAGE_REGION': JSON.stringify(env.VITE_STORAGE_REGION || ''),
      'import.meta.env.VITE_STORAGE_IDENTITY_POOL_ID': JSON.stringify(env.VITE_STORAGE_IDENTITY_POOL_ID || ''),
      'import.meta.env.VITE_COGNITO_USER_POOL_ID': JSON.stringify(env.VITE_COGNITO_USER_POOL_ID || ''),
      'import.meta.env.VITE_COGNITO_CLIENT_ID': JSON.stringify(env.VITE_COGNITO_CLIENT_ID || ''),
    },
  };
});
