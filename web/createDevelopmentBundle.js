require('esbuild').build({
  entryPoints: ['main.tsx'],
  bundle: true,
  outfile: 'js/bundle.js',
}).catch(() => process.exit(1)) 
