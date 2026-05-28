# Secrets Manager placeholders.
# Real values are populated manually out-of-band during GitHub App setup:
#   * webhook_secret         — HMAC secret configured when registering the GitHub App
#   * github_app_private_key — PEM-encoded private key downloaded from the GitHub App
#
# Placeholders use ignore_changes so terraform never overwrites values set
# via the AWS console or `aws secretsmanager put-secret-value`.

resource "aws_secretsmanager_secret" "webhook_secret" {
  name        = "${var.project_name}/webhook-secret"
  description = "HMAC secret shared with the GitHub App for webhook signature verification."

  # Learner Lab accounts get destroyed; no recovery window needed.
  recovery_window_in_days = 0
}

resource "aws_secretsmanager_secret_version" "webhook_secret_placeholder" {
  secret_id     = aws_secretsmanager_secret.webhook_secret.id
  secret_string = "PLACEHOLDER_OVERWRITE_OUT_OF_BAND"

  lifecycle {
    ignore_changes = [secret_string]
  }
}

resource "aws_secretsmanager_secret" "github_app_private_key" {
  name        = "${var.project_name}/github-app-private-key"
  description = "PEM-encoded private key for the GitHub App (used to sign JWTs and exchange for installation tokens)."

  recovery_window_in_days = 0
}

resource "aws_secretsmanager_secret_version" "github_app_private_key_placeholder" {
  secret_id     = aws_secretsmanager_secret.github_app_private_key.id
  secret_string = "PLACEHOLDER_OVERWRITE_OUT_OF_BAND"

  lifecycle {
    ignore_changes = [secret_string]
  }
}
