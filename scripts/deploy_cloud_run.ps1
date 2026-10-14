# Cloud Run Deployment Script for Kodimi
Write-Host "Deploying Kodimi to Google Cloud Run (project: ismizo, region: europe-west4)..."

$PROJECT_ID = "ismizo"
$REGION = "europe-west4"
$SERVICE_NAME = "kodimi"
$BUCKET_NAME = "torrentz"

# Ensure gcloud project is set
gcloud config set project $PROJECT_ID

Write-Host "Building and deploying service to Cloud Run..."

gcloud run deploy $SERVICE_NAME `
  --source . `
  --region $REGION `
  --platform managed `
  --allow-unauthenticated `
  --memory 4Gi `
  --cpu 2 `
  --timeout 3600 `
  --set-env-vars "NODE_ENV=production,GCS_BUCKET_NAME=$BUCKET_NAME,GCP_PROJECT_ID=$PROJECT_ID" `
  --set-secrets "ADMIN_PASSWORD=KODIMI_ADMIN_PASSWORD:latest,PRIVATE_PIN=KODIMI_PRIVATE_PIN:latest,MONGO_URI=KODIMI_MONGO_URI:latest,GEMINI_API_KEY=KODIMI_GEMINI_API_KEY:latest,JWT_SECRET=KODIMI_JWT_SECRET:latest"

Write-Host "Mapping custom domain kodimi.mnembo.com..."

gcloud beta run domain-mappings create `
  --service $SERVICE_NAME `
  --domain kodimi.mnembo.com `
  --region $REGION `
  --project $PROJECT_ID

Write-Host "Deployment and Domain Mapping completed!"
