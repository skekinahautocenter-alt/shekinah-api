const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Conexão com o banco (Neon)
const pool = new Pool({
  connectionString: "postgresql://neondb_owner:npg_0byBcxNEvgG7@ep-cold-mud-acoegvhx-pooler.sa-east-1.aws.neon.tech/neondb?sslmode=require",
  ssl: { rejectUnauthorized: false }
});

// ============ ROTA PRINCIPAL (teste) ============
app.get('/', (req, res) => {
  res.json({ 
    message: 'API Shekinah Auto Center funcionando! 🚀',
    endpoints: {
      produtos: '/api/produtos',
      produto_especifico: '/api/produtos/:id'
    }
  });
});

// ============ ENDPOINTS DA API ============

// GET /api/produtos - Listar todos os produtos
app.get('/api/produtos', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM produtos ORDER BY id DESC');
    res.json(result.rows);
  } catch (error) {
    console.error('Erro ao buscar produtos:', error);
    res.status(500).json({ error: 'Erro ao buscar produtos' });
  }
});

// GET /api/produtos/:id - Buscar um produto específico
app.get('/api/produtos/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query('SELECT * FROM produtos WHERE id = $1', [id]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Produto não encontrado' });
    }
    
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Erro ao buscar produto:', error);
    res.status(500).json({ error: 'Erro ao buscar produto' });
  }
});

// POST /api/produtos - Criar um novo produto
app.post('/api/produtos', async (req, res) => {
  try {
    const {
      title, name, nome,
      category, categoria,
      price, preco,
      description, descricao,
      brand, marca,
      size, medida, aro,
      tags
    } = req.body;

    const result = await pool.query(
      `INSERT INTO produtos (
        title, name, nome,
        category, categoria,
        price, preco,
        description, descricao,
        brand, marca,
        size, medida, aro,
        tags
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
      RETURNING *`,
      [
        title, name, nome,
        category, categoria,
        price, preco,
        description, descricao,
        brand, marca,
        size, medida, aro,
        tags || []
      ]
    );
    
    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error('Erro ao criar produto:', error);
    res.status(500).json({ error: 'Erro ao criar produto' });
  }
});

// PUT /api/produtos/:id - Atualizar um produto
app.put('/api/produtos/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const {
      title, name, nome,
      category, categoria,
      price, preco,
      description, descricao,
      brand, marca,
      size, medida, aro,
      tags
    } = req.body;
    
    const result = await pool.query(
      `UPDATE produtos SET
        title = COALESCE($1, title),
        name = COALESCE($2, name),
        nome = COALESCE($3, nome),
        category = COALESCE($4, category),
        categoria = COALESCE($5, categoria),
        price = COALESCE($6, price),
        preco = COALESCE($7, preco),
        description = COALESCE($8, description),
        descricao = COALESCE($9, descricao),
        brand = COALESCE($10, brand),
        marca = COALESCE($11, marca),
        size = COALESCE($12, size),
        medida = COALESCE($13, medida),
        aro = COALESCE($14, aro),
        tags = COALESCE($15, tags),
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $16
      RETURNING *`,
      [
        title, name, nome,
        category, categoria,
        price, preco,
        description, descricao,
        brand, marca,
        size, medida, aro,
        tags,
        id
      ]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Produto não encontrado' });
    }
    
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Erro ao atualizar produto:', error);
    res.status(500).json({ error: 'Erro ao atualizar produto' });
  }
});

// DELETE /api/produtos/:id - Deletar um produto
app.delete('/api/produtos/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query('DELETE FROM produtos WHERE id = $1 RETURNING *', [id]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Produto não encontrado' });
    }
    
    res.json({ message: 'Produto deletado com sucesso', id: parseInt(id) });
  } catch (error) {
    console.error('Erro ao deletar produto:', error);
    res.status(500).json({ error: 'Erro ao deletar produto' });
  }
});

// Iniciar o servidor
app.listen(PORT, () => {
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
  console.log(`📦 API disponível em http://localhost:${PORT}/api/produtos`);
});
