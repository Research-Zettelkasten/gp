/* Apply saved appearance before the first paint; no account data is stored. */
try{document.documentElement.dataset.gpTheme=localStorage.getItem('gp2_theme_default')==='dark'?'dark':'light';}catch{document.documentElement.dataset.gpTheme='light';}
