import { defineConfig } from 'vite';
import { rozenitePlugin } from '@rozenite/vite-plugin';

export default defineConfig({
  plugins: [rozenitePlugin()],
  resolve: { alias: { 'react-native': 'react-native-web' } },
});
