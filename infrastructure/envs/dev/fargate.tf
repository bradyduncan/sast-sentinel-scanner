# Fargate cluster + scanner task definition.
# Step Functions invokes the task with container overrides per docs/contracts.md.

resource "aws_ecs_cluster" "sast" {
  name = var.project_name

  # Container Insights surfaces CPU, memory, network, and storage metrics
  # for every task in the cluster. Visible in the CloudWatch dashboard
  # defined in monitoring.tf.
  setting {
    name  = "containerInsights"
    value = "enabled"
  }
}

resource "aws_cloudwatch_log_group" "scanner" {
  name              = "/ecs/${var.project_name}-scanner"
  retention_in_days = 7
}

resource "aws_ecs_task_definition" "scanner" {
  family                   = "${var.project_name}-scanner"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = "256"
  memory                   = "512"

  # Both task role and execution role = LabRole. Learner Lab blocks iam:CreateRole.
  task_role_arn      = data.aws_iam_role.lab.arn
  execution_role_arn = data.aws_iam_role.lab.arn

  container_definitions = jsonencode([
    {
      name      = "scanner"
      image     = "${aws_ecr_repository.scanner.repository_url}:latest"
      essential = true

      # No defaults here. Step Functions injects required env vars as container
      # overrides at task launch time (JOB_ID, STAGING_BUCKET, STAGING_KEY,
      # RESULTS_BUCKET, RESULTS_KEY, JOBS_TABLE).
      environment = [
        { name = "AWS_REGION", value = var.region },
      ]

      logConfiguration = {
        logDriver = "awslogs"
        options = {
          awslogs-group         = aws_cloudwatch_log_group.scanner.name
          awslogs-region        = var.region
          awslogs-stream-prefix = "scanner"
        }
      }
    }
  ])
}
