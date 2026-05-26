import { cpSync } from 'node:fs';

cpSync('src/infrastructure/store/migrations', 'dist/infrastructure/store/migrations', {
  recursive: true,
});
