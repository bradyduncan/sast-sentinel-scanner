# VPC for the SAST pipeline.
#
# Layout:
#   VPC 10.0.0.0/16
#   ├── Public subnets  (10.0.0.0/24, 10.0.1.0/24)   in 2 AZs — host the NAT Gateway
#   ├── Private subnets (10.0.10.0/24, 10.0.11.0/24) in 2 AZs — Fargate task runs here
#   ├── Internet Gateway                              for outbound internet access from public subnets
#   └── NAT Gateway (single, in public[0])            for private subnet acccess to AWS APIs
#
# A single NAT means losing the NAT's AZ still isolates Fargate. Typical production would use 
# one NAT per AZ. For class scope + Learner Lab credit constraints, we use one NAT.
# Documented in docs/architecture.md.
#
# Cost-saving destroy/recreate (avoiding idle NAT costs on AWS):
#   terraform destroy \
#     -target=aws_route.private_nat \
#     -target=aws_nat_gateway.main \
#     -target=aws_eip.nat
#   # ...later, to bring it back:
#   terraform apply

# ---- AZ lookup ----

data "aws_availability_zones" "available" {
  state = "available"
}

// Pick the first 2 available AZs in the region (i.e. us-east-1a and us-east-1b)
locals {
  azs = slice(data.aws_availability_zones.available.names, 0, 2)
}

# ---- VPC ----

// The VPC, DNS enabled (required for AWS service endpoints to resolve)
resource "aws_vpc" "main" {
  cidr_block           = "10.0.0.0/16"
  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = {
    Name = "${var.project_name}-vpc"
  }
}

# ---- Subnets ----

// 2 public subnets
// 10.0.0.0/24 (AZ-a) and 10.0.1.0/24 (AZ-b)
// Host the NAT gateway, map public IPs
resource "aws_subnet" "public" {
  count                   = 2
  vpc_id                  = aws_vpc.main.id
  cidr_block              = "10.0.${count.index}.0/24"
  availability_zone       = local.azs[count.index]
  map_public_ip_on_launch = true

  tags = {
    Name = "${var.project_name}-public-${count.index}"
    Tier = "public"
  }
}

// 2 private subnets
// 10.0.10.0/24 (AZ-a) and 10.0.11.0/24 (AZ-b)
// Fargate goes here
resource "aws_subnet" "private" {
  count             = 2
  vpc_id            = aws_vpc.main.id
  cidr_block        = "10.0.${count.index + 10}.0/24"
  availability_zone = local.azs[count.index]

  tags = {
    Name = "${var.project_name}-private-${count.index}"
    Tier = "private"
  }
}

# ---- Internet Gateway (serves public subnets) ----

resource "aws_internet_gateway" "main" {
  vpc_id = aws_vpc.main.id

  tags = {
    Name = "${var.project_name}-igw"
  }
}

# ---- NAT Gateway (single NAT Gateway; serves both private subnets) ----

// AWS Elastic IP
resource "aws_eip" "nat" {
  domain     = "vpc"
  depends_on = [aws_internet_gateway.main]

  tags = {
    Name = "${var.project_name}-nat-eip"
  }
}

// One NAT in public[0] (AZ-a) with its own elastic IP
resource "aws_nat_gateway" "main" {
  allocation_id = aws_eip.nat.id
  subnet_id     = aws_subnet.public[0].id
  depends_on    = [aws_internet_gateway.main]

  tags = {
    Name = "${var.project_name}-nat"
  }
}

# ---- Route Tables ----

// Internet gateway, inline route
resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.main.id
  }

  tags = {
    Name = "${var.project_name}-public-rt"
  }
}

// Private, no inline route, bare route table
resource "aws_route_table" "private" {
  vpc_id = aws_vpc.main.id

  # NAT-bound default route is defined as a separate aws_route below so
  # the route can be destroyed/recreated alongside the NAT without
  # tearing down the route table itself.

  tags = {
    Name = "${var.project_name}-private-rt"
  }
}

resource "aws_route" "private_nat" {
  route_table_id         = aws_route_table.private.id
  destination_cidr_block = "0.0.0.0/0"
  nat_gateway_id         = aws_nat_gateway.main.id
}

// Wires public subnets to their respective route table
resource "aws_route_table_association" "public" {
  count          = 2
  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}

// Wires private subnets to their respective route table
resource "aws_route_table_association" "private" {
  count          = 2
  subnet_id      = aws_subnet.private[count.index].id
  route_table_id = aws_route_table.private.id
}

# ---- Security Group for the Fargate scanner task ----

// Outbound 443 to anywhere (NAT routes that to the AWS APIs)
resource "aws_security_group" "fargate" {
  name        = "${var.project_name}-fargate"
  description = "Egress for Fargate scanner task to reach AWS APIs"
  vpc_id      = aws_vpc.main.id

  egress {
    description = "HTTPS to AWS service endpoints (ECR, S3, DynamoDB, CloudWatch, etc.)"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name = "${var.project_name}-fargate"
  }
}
