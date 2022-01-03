require('esbuild').build({
  entryPoints: ['main.tsx'],
  define:{
    "process.env.NODE_ENV": "\"production\""
  },
  bundle: true,
  minify: true,
  outfile: 'js/bundle.min.js',
}).catch(() => process.exit(1)) 
