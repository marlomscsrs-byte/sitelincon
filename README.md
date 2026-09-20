# Villa • Central de Solicitações

Versão de teste operacional, sem dados ou telas de demonstração.

## Rodar localmente

```bash
npm install
npm start
```

Acesse `http://localhost:3000`.

## Banco de dados

Para autenticação, cadastro e solicitações funcionarem de forma persistente, configure `DATABASE_URL` apontando para PostgreSQL. O servidor cria as tabelas e as áreas/tipos padrão na inicialização.

## Administrador

Defina `ADMIN_USERNAME`, `ADMIN_PASSWORD`, `ADMIN_EMAIL` (para recuperação de senha) e `JWT_SECRET` no ambiente. Na inicialização, a conta indicada por `ADMIN_USERNAME` é criada/atualizada como administradora. O e-mail não é usado para escolher qual conta vira administradora.

## Áreas padrão

Hospital, Eventos, Peds, Creators, Mecânicas, Restaurantes, Polícia, Ilegal, Denúncias, Jornal, Judiciário, Screen Share, Administrativa e Desenvolvimento.

## Observação

Esta versão não possui dados fictícios, login de demonstração, botão de prévia ou indicadores estáticos. O painel e as listas passam a refletir os registros reais do banco.
