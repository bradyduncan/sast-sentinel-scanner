# CloudWatch dashboard for the SAST scanner pipeline.
#
# Widgets:
#   - Top-left:     Scanner Fargate CPU utilization (Container Insights)
#   - Top-right:    Scanner Fargate memory utilization (Container Insights)
#   - Bottom-left:  Step Functions execution count by status
#   - Bottom-right: Step Functions execution duration (end-to-end pipeline latency)
#
# Container Insights must be enabled on the ECS cluster for the top widgets
# to populate — see the `containerInsights` setting in fargate.tf.

resource "aws_cloudwatch_dashboard" "pipeline" {
  dashboard_name = "${var.project_name}-pipeline"

  dashboard_body = jsonencode({
    widgets = [
      {
        type   = "metric"
        x      = 0
        y      = 0
        width  = 12
        height = 6
        properties = {
          title  = "Scanner Fargate — CPU utilization (CPU units; 1024 = 1 vCPU)"
          view   = "timeSeries"
          region = var.region
          stat   = "Average"
          period = 60
          metrics = [
            ["ECS/ContainerInsights", "CpuUtilized", "ClusterName", aws_ecs_cluster.sast.name, "TaskDefinitionFamily", aws_ecs_task_definition.scanner.family]
          ]
        }
      },
      {
        type   = "metric"
        x      = 12
        y      = 0
        width  = 12
        height = 6
        properties = {
          title  = "Scanner Fargate — Memory utilization (MiB)"
          view   = "timeSeries"
          region = var.region
          stat   = "Average"
          period = 60
          metrics = [
            ["ECS/ContainerInsights", "MemoryUtilized", "ClusterName", aws_ecs_cluster.sast.name, "TaskDefinitionFamily", aws_ecs_task_definition.scanner.family]
          ]
        }
      },
      {
        type   = "metric"
        x      = 0
        y      = 6
        width  = 12
        height = 6
        properties = {
          title  = "Step Functions — Executions by status"
          view   = "timeSeries"
          region = var.region
          stat   = "Sum"
          period = 300
          metrics = [
            ["AWS/States", "ExecutionsSucceeded", "StateMachineArn", aws_sfn_state_machine.pipeline.arn],
            [".", "ExecutionsFailed", ".", "."],
            [".", "ExecutionsStarted", ".", "."]
          ]
        }
      },
      {
        type   = "metric"
        x      = 12
        y      = 6
        width  = 12
        height = 6
        properties = {
          title  = "Step Functions — End-to-end pipeline duration (ms, avg)"
          view   = "timeSeries"
          region = var.region
          stat   = "Average"
          period = 300
          metrics = [
            ["AWS/States", "ExecutionTime", "StateMachineArn", aws_sfn_state_machine.pipeline.arn]
          ]
        }
      }
    ]
  })
}

output "dashboard_url" {
  description = "URL to the CloudWatch dashboard for the SAST pipeline."
  value       = "https://${var.region}.console.aws.amazon.com/cloudwatch/home?region=${var.region}#dashboards:name=${aws_cloudwatch_dashboard.pipeline.dashboard_name}"
}
