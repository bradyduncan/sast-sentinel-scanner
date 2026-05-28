# ECR repo for the Fargate scanner container image.
# Push from local with:
#   aws ecr get-login-password --region us-east-1 | docker login --username AWS --password-stdin <repo>
#   docker tag sast-scanner:dev <repo>:latest
#   docker push <repo>:latest

resource "aws_ecr_repository" "scanner" {
  name                 = "${var.project_name}-scanner"
  image_tag_mutability = "MUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }

  encryption_configuration {
    encryption_type = "AES256"
  }
}

# Keep only the last 10 images to control storage cost.
resource "aws_ecr_lifecycle_policy" "scanner" {
  repository = aws_ecr_repository.scanner.name

  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "Keep last 10 images"
      selection = {
        tagStatus   = "any"
        countType   = "imageCountMoreThan"
        countNumber = 10
      }
      action = { type = "expire" }
    }]
  })
}
