// Execução local: npm start  (na Vercel é usado api/index.js)
const express = require('express'), path = require('path');
const api = require('./app');
const app = express();
app.use(api);
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.use(express.static(path.join(__dirname, 'public')));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Rodando em http://localhost:${PORT}  (admin: /admin.html)`));
