# Cloud Run Deployment Script for Kodimi (Dual-Service Architecture)
Write-Host "Deploying Kodimi Services to Google Cloud Run (project: ismizo, region: europe-west4)..."

$PROJECT_ID = "ismizo"
$REGION = "europe-west4"
$BUCKET_NAME = "torrentz"
$WORKER_URL = "https://kodimi-worker-902784200253.europe-west4.run.app"

# Ensure gcloud project is set
gcloud config set project $PROJECT_ID

Write-Host "1. Deploying Dedicated Torrent Downloader Worker (kodimi-worker: 4Gi RAM, 2 vCPU, min-instances 0)..."

gcloud run deploy kodimi-worker `
  --source . `
  --region $REGION `
  --platform managed `
  --allow-unauthenticated `
  --memory 4Gi `
  --cpu 2 `
  --min-instances 0 `
  --max-instances 1 `
  --concurrency 80 `
  --no-cpu-throttling `
  --timeout 3600 `
  --set-env-vars "NODE_ENV=production,IS_WORKER=true,GCS_BUCKET_NAME=$BUCKET_NAME,GCP_PROJECT_ID=$PROJECT_ID,SERVICE_URL=$WORKER_URL" `
  --set-secrets "ADMIN_PASSWORD=KODIMI_ADMIN_PASSWORD:latest,PRIVATE_PIN=KODIMI_PRIVATE_PIN:latest,MONGO_URI=KODIMI_MONGO_URI:latest,GEMINI_API_KEY=KODIMI_GEMINI_API_KEY:latest,JWT_SECRET=KODIMI_JWT_SECRET:latest"

Write-Host "2. Deploying Streaming Service (kodimi: 2Gi RAM, 2 vCPU, min-instances 0, max-instances 6)..."

gcloud run deploy kodimi `
  --source . `
  --region $REGION `
  --platform managed `
  --allow-unauthenticated `
  --memory 2Gi `
  --cpu 2 `
  --min-instances 0 `
  --max-instances 6 `
  --concurrency 80 `
  --cpu-throttling `
  --timeout 3600 `
  --set-env-vars "NODE_ENV=production,IS_WORKER=false,WORKER_SERVICE_URL=$WORKER_URL,GCS_BUCKET_NAME=$BUCKET_NAME,GCP_PROJECT_ID=$PROJECT_ID,SERVICE_URL=https://kodimi.mnembo.com" `
  --set-secrets "ADMIN_PASSWORD=KODIMI_ADMIN_PASSWORD:latest,PRIVATE_PIN=KODIMI_PRIVATE_PIN:latest,MONGO_URI=KODIMI_MONGO_URI:latest,GEMINI_API_KEY=KODIMI_GEMINI_API_KEY:latest,JWT_SECRET=KODIMI_JWT_SECRET:latest"

Write-Host "Dual-Service Deployment completed!"
