module.exports = function registerProducts(app, pool, requireAdmin) {
// GET /api/produtos - Listar todos os produtos
app.get('/api/produtos', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM produtos ORDER BY id DESC');
    res.json(result.rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Erro ao buscar produtos' });
  }
});

// GET /api/produtos/:id - Buscar um produto
app.get('/api/produtos/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query('SELECT * FROM produtos WHERE id = $1', [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Produto não encontrado' });
    }
    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: 'Erro ao buscar produto' });
  }
});

// POST /api/produtos - Criar produto
app.post('/api/produtos', requireAdmin, async (req, res) => {
  try {
    const { title, name, nome, category, categoria, price, preco, description, descricao, brand, marca, size, medida, aro, tags } = req.body;
    
    const result = await pool.query(
      `INSERT INTO produtos (title, name, nome, category, categoria, price, preco, description, descricao, brand, marca, size, medida, aro, tags)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
       RETURNING *`,
      [title, name, nome, category, categoria, price, preco, description, descricao, brand, marca, size, medida, aro, tags || []]
    );
    
    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Erro ao criar produto' });
  }
});

// PUT /api/produtos/:id - Atualizar produto
app.put('/api/produtos/:id', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { title, category, price, description, tags } = req.body;
    
    const result = await pool.query(
      `UPDATE produtos 
       SET title = $1, category = $2, price = $3, description = $4, tags = $5, updated_at = CURRENT_TIMESTAMP
       WHERE id = $6 RETURNING *`,
      [title, category, price, description, tags, id]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Produto não encontrado' });
    }
    
    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: 'Erro ao atualizar produto' });
  }
});

// DELETE /api/produtos/:id - Deletar produto
app.delete('/api/produtos/:id', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query('DELETE FROM produtos WHERE id = $1 RETURNING *', [id]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Produto não encontrado' });
    }
    
    res.json({ message: 'Produto deletado com sucesso' });
  } catch (error) {
    res.status(500).json({ error: 'Erro ao deletar produto' });
  }
});


};

