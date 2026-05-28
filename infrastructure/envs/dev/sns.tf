# SNS topic for HIGH-severity scan alerts.
# Step Functions Choice state publishes to this topic when summary.high >= 1.
# Email subscription is added out-of-band (subscriber confirms via emailed link)
# or by setting var.alert_email to a non-empty value.

resource "aws_sns_topic" "high_severity" {
  name = "${var.project_name}-high-severity"
}

resource "aws_sns_topic_subscription" "high_severity_email" {
  count     = var.alert_email == "" ? 0 : 1
  topic_arn = aws_sns_topic.high_severity.arn
  protocol  = "email"
  endpoint  = var.alert_email
}
