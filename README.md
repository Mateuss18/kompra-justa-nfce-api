# Kompra Justa - NFC-e Parser API

API serverless para extração de dados de Notas Fiscais de Consumidor Eletrônica (NFC-e) a partir da URL do QR Code.

## O que faz

Recebe uma URL da NFC-e (ex: `https://www.nfce.fazenda.sp.gov.br/...`), consulta a SEFAZ, extrai os dados da nota (nome do estabelecimento, data, itens, valores) e retorna em JSON.

## Arquitetura

- **AWS Lambda** (Node.js 20.x)
- **API Gateway** (região `sa-east-1`)
- **Endpoint**: `POST https://scb4lft3c8.execute-api.sa-east-1.amazonaws.com/nfce/parse`

### Body da requisição

```json
{
  "url": "https://www.nfce.fazenda.sp.gov.br/NFCeConsultaPublica/Paginas/ConsultaQRCode.aspx?p=..."
}
```

### Resposta de sucesso (200)

```json
{
  "marketName": "americanas sa - 0194",
  "purchaseDate": "2026-07-03T21:20:43",
  "total": 34.97,
  "items": [
    {
      "name": "BALA GELATINA AMORAS 80G FINI",
      "quantity": 1,
      "unit": "PCE",
      "unitPrice": 7.5,
      "totalPrice": 7.5
    }
  ]
}
```

### Respostas de erro

| Status | Significado |
|--------|-------------|
| 400 | URL inválida ou malformada |
| 404 | Nota ainda não disponível na SEFAZ |
| 502 | Erro da SEFAZ (indisponível, layout mudou) |
| 503 | SEFAZ bloqueando requisições (rate limit) |
| 504 | Timeout na consulta à SEFAZ |
| 500 | Erro interno inesperado |

## Como fazer deploy

### Opção 1: Deploy automático via GitHub Actions (recomendado)

O projeto já tem um workflow configurado em `.github/workflows/deploy.yml`. A cada push na branch `main`, o GitHub Actions compila e faz upload do código direto pra Lambda.

#### Configuração única

1. No Console AWS, crie um usuário IAM com permissão `lambda:UpdateFunctionCode` na função `nfce-parser`.
2. Copie o **Access Key ID** e **Secret Access Key**.
3. No repositório GitHub, vá em **Settings > Secrets and variables > Actions > New repository secret** e adicione:
   - `AWS_ACCESS_KEY_ID`
   - `AWS_SECRET_ACCESS_KEY`

Pronto! Da próxima vez que der `git push` na `main`, o deploy acontece sozinho. Você também pode acionar manualmente em **Actions > Deploy to AWS Lambda > Run workflow**.

### Opção 2: Deploy manual pelo console AWS

Use essa opção se precisar fazer deploy sem usar o GitHub Actions.

1. **Instalar dependências** (se necessário):
   ```bash
   npm install
   ```

2. **Build + empacotamento** (gera o `lambda.zip`):
   ```bash
   npm run package
   ```
   Este comando:
   - Limpa a pasta `dist` e o `lambda.zip` anterior
   - Compila o TypeScript (`tsc`)
   - Cria o zip contendo `dist/`, `node_modules/` e `package.json`

3. **Fazer upload na AWS**:
   - Acesse o [Console AWS Lambda](https://sa-east-1.console.aws.amazon.com/lambda)
   - Encontre a função `nfce-parser`
   - Vá em **Código** > **Upload from** > **.zip file**
   - Selecione o arquivo `lambda.zip` gerado na raiz do projeto
   - A função já está configurada com o handler `dist/handler.handler`

4. **Testar**:
   - Use o botão **Test** no console da Lambda, ou
   - Chame o endpoint via curl/Postman, ou
   - Escanee uma nota pelo app

### Scripts disponíveis

```bash
npm run clean    # Remove dist/ e lambda.zip
npm run build    # Compila TypeScript
npm run zip      # Gera lambda.zip (requer PowerShell no Windows)
npm run package  # clean + build + zip (comando completo)
```

## Estrutura do projeto

```
kompra-justa-nfce-api/
├── src/
│   └── handler.ts          # Código principal (Lambda handler)
├── dist/                   # Código compilado (gerado pelo tsc)
├── node_modules/           # Dependências
├── package.json            # Scripts e dependências
├── tsconfig.json           # Config do TypeScript
├── lambda.zip              # Pacote de deploy (gerado)
├── README.md               # Este arquivo
└── AGENTS.md               # Instruções para agents de código
```

## Dependências

| Pacote | Versão | Uso |
|--------|--------|-----|
| `axios` | ^1.14.0 | Requisições HTTP à SEFAZ |
| `cheerio` | ^1.2.0 | Parsing do HTML da NFC-e |
| `@types/aws-lambda` | ^8.10.161 | Tipos da Lambda (dev) |
| `typescript` | ^6.0.2 | Compilação (dev) |

## Suporte a estados

Atualmente há suporte apenas para **São Paulo (SP)**. Notas de outros estados recebem `422` com o código `UNSUPPORTED_STATE`. Para adicionar suporte a outro estado, crie uma função `parseXX(html)` no `handler.ts` e adicione a condição no roteamento.

## Notas importantes

- A SEFAZ-SP às vezes bloqueia ou limita requisições vindas de datacenters (AWS). Se notar muitos erros 503, pode ser necessário usar um proxy ou aumentar o intervalo entre requisições no app.
- A nota pode demorar alguns minutos (até ~30 min) para ficar disponível na consulta pública após a emissão.
- A URL do QR Code de SP contém pipes (`|`) no parâmetro `p`. A API normaliza isso automaticamente.
