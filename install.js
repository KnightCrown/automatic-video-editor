import { execSync } from 'child_process';
console.log('Installing dependencies...');
execSync('npm install', { stdio: 'inherit' });
console.log('Done.');