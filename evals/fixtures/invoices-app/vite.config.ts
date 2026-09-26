import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { mockApi } from './mock/api';

export default defineConfig({
  plugins: [react(), mockApi()],
});
