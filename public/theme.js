try { document.documentElement.dataset.theme = localStorage.getItem('plm-theme') || 'dark'; } catch (e) { document.documentElement.dataset.theme = 'dark'; }
