# API Centro Automotivo Shekinah

API Express + PostgreSQL usada pelo site e pelo ADM. O banner é armazenado em uma única linha (`site_banner`, coluna BYTEA), sem depender do disco temporário da Vercel ou de outro serviço de upload.

## Configuração obrigatória

Instale com `pnpm install --frozen-lockfile`. Use Node.js 22 ou 24 e as variáveis do `.env.example`:

- `DATABASE_URL`: conexão PostgreSQL com pooling para a API.
- `DATABASE_URL_UNPOOLED`: conexão direta para executar a migração; não precisa ser exposta ao frontend.
- `ADMIN_PASSWORD`: senha inicial não vazia, de até 256 caracteres, usada somente para criar o primeiro hash em `admin_credentials`. Depois disso, a senha é alterada pelo ADM; editar esta variável não substitui a senha cadastrada.
- `ADMIN_SESSION_SECRET`: segredo aleatório independente de pelo menos 32 caracteres, usado para assinar sessões de até 8 horas.
- `PORT`: opcional, 3000 em desenvolvimento.

Configure as variáveis no servidor/hosting. Nunca coloque valores reais em HTML, README, PR, commit ou URL pública. A credencial de banco e a senha administrativa presentes no código anterior devem ser substituídas antes da publicação; removê-las da versão atual não as retira do histórico público. Ao invalidar sessões existentes, troque também `ADMIN_SESSION_SECRET`.

## Migração e ordem de publicação

1. Configure uma conexão de teste isolada e execute `pnpm migrate`. As migrações versionadas criam `site_banner`, `admin_login_limits` e `admin_credentials`; são idempotentes e não modificam a tabela de produtos. Conceda ao papel da aplicação SELECT, INSERT e UPDATE em `admin_credentials`.
2. Valide o teste com `pnpm test`. A suíte usa PostgreSQL local via PGlite e não acessa o Neon nem dados de produção.
3. Na publicação, configure os segredos, execute a mesma migração com conexão direta autorizada e publique a API.
4. Publique o ADM e o site correspondentes. **Coordene API e ADM:** a versão antiga do painel não envia token e deixará de conseguir editar produtos quando a API nova entrar no ar.
5. Entre no ADM com a nova senha, envie uma arte e confira no site. Não é necessário novo deploy a cada troca de banner.

`pnpm start` inicia o servidor local. Na Vercel, `api/index.js` exporta o app para o roteamento existente em `vercel.json`.

## Contrato

| Rota | Acesso | Comportamento |
| --- | --- | --- |
| `POST /api/admin/login` | Senha | Recebe `{ password }`, devolve `{ token, expiresAt }`. |
| `GET /api/admin/session` | Bearer | Valida a sessão. |
| `GET /api/banner` | Público | `{ banner: null }` ou metadados com `imageUrl`, `altText`, `width`, `height`, `updatedAt`. |
| `GET /api/banner/image?v=...` | Público | Imagem WebP com ETag e revalidação de cache. |
| `PUT /api/banner` | Bearer | Recebe `{ imageData, altText }` e substitui o banner em uma operação atômica. |
| `DELETE /api/banner` | Bearer | Remove a arte personalizada; o site volta à arte padrão. |
| `GET /api/produtos[/id]` | Público | Mantém as leituras do catálogo. |
| `POST/PUT/DELETE /api/produtos[/id]` | Bearer | Edição autenticada pelo mesmo token do painel. |

`imageData` é uma data URL base64 PNG, JPEG ou WebP. A API limita o arquivo a 2 MB, valida conteúdo e dimensões exatas de 1080 × 1080 e rejeita imagens animadas, SVGs, corrupção e tipo declarado incompatível. O servidor decodifica e reencoda a imagem em WebP, sem metadados. `altText` é obrigatório, com até 180 caracteres.

Há limite compartilhado no banco de 10 tentativas de login por IP por janela de 15 minutos, inclusive em múltiplas instâncias. Sem segredos configurados, o acesso administrativo retorna 503 e permanece bloqueado. CORS permite o site e o painel em origens distintas; a permissão de escrita depende sempre do Bearer token.

## Validação

A suíte cobre upload, substituição, remoção, leitura por outra instância, dimensões da imagem servida, cache/ETag, autenticação e expiração, formatos inválidos, limite de tamanho, descrição, limite de login, falhas do banco e CRUD do catálogo. Também corrige o INSERT preexistente de produtos, que tinha 16 placeholders para 15 colunas.

A integração foi verificada no navegador com cópias locais do ADM e site apontadas à API isolada; o upload foi visto por uma segunda sessão. Nenhuma imagem ou produto de teste foi enviado ao ambiente publicado.

## Alterar a senha pelo painel

No ADM, use **Alterar senha**, informe a senha atual e confirme a nova (não vazia, com até 256 caracteres). O banco guarda somente um hash scrypt com salt aleatório. A alteração incrementa a versão da credencial e invalida todas as sessões anteriores, inclusive em outras instâncias da API. A senha inicial da variável de ambiente não funciona como senha de recuperação após uma alteração. O endpoint `PUT /api/admin/password` exige Bearer e recebe `{currentPassword,newPassword,confirmPassword}`. Há limite de 10 tentativas por IP a cada 15 minutos.

Recuperação em caso de esquecimento exige um administrador autorizado do banco: gere um novo hash usando o mesmo formato scrypt de `lib/admin-auth.js` e atualize a linha incrementando `version`. Não apague a linha, pois isso reativaria a senha inicial do ambiente.
