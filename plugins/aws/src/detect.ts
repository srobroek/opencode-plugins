import { join } from "node:path"
import { entries, hasAny, packageDependencies, readSmall } from "@srobroek/opencode-lib/project-markers"

/** Files or directories whose presence alone marks AWS work. */
export const AWS_MARKERS = [
  "cdk.json",
  "cdk.context.json",
  "samconfig.toml",
  "samconfig.yaml",
  "samconfig.yml",
  ".aws-sam",
  "serverless.yml",
  "serverless.yaml",
  "serverless.ts",
  "amplify/backend.ts",
  "amplify/.config",
  "copilot/.workspace",
  ".chalice",
  "buildspec.yml",
  "appspec.yml",
] as const

/** Subdirectories also searched for Terraform and CloudFormation files. */
export const IAC_DIRECTORIES = ["infra", "infrastructure", "terraform", "iac", "deploy", "cloudformation", "cfn"] as const

const TERRAFORM_AWS = /provider\s+"aws"|hashicorp\/aws|terraform-aws-modules\//
const CLOUDFORMATION = /AWSTemplateFormatVersion|AWS::Serverless|Type:\s*["']?AWS::/
const NPM_AWS = /^(?:aws-cdk-lib|aws-cdk|@aws-cdk\/.+|@aws-sdk\/.+|aws-sdk|@pulumi\/aws|serverless|@aws-amplify\/.+|sst)$/
const PYTHON_AWS = /\b(?:boto3|aws-cdk-lib|aws_cdk|pulumi[-_]aws|chalice|aws-sam-cli)\b/i
const GO_AWS = /github\.com\/aws\/(?:aws-sdk-go|aws-cdk-go)|pulumi-aws/

function templateMarksAws(directory: string, name: string): boolean {
  if (/\.tf$/.test(name)) return TERRAFORM_AWS.test(readSmall(join(directory, name)) ?? "")
  if (/^(?:template|.*\.cfn|.*cloudformation.*|.*\.template)\.(?:ya?ml|json)$/i.test(name))
    return CLOUDFORMATION.test(readSmall(join(directory, name)) ?? "")
  return false
}

function scanIac(directory: string): boolean {
  return entries(directory).some((name) => templateMarksAws(directory, name))
}

function pulumiAws(directory: string): boolean {
  return entries(directory).some(
    (name) => /^Pulumi\..+\.ya?ml$/.test(name) && /^\s*aws:/m.test(readSmall(join(directory, name)) ?? ""),
  )
}

/** Whether `directory` looks like a project that does AWS work. Reads root files and a few IaC folders. */
export function isAwsProject(directory: string): boolean {
  if (hasAny(directory, AWS_MARKERS)) return true
  if (scanIac(directory)) return true
  if (IAC_DIRECTORIES.some((sub) => scanIac(join(directory, sub)))) return true
  if (pulumiAws(directory)) return true
  if (packageDependencies(directory).some((name) => NPM_AWS.test(name))) return true
  for (const file of ["requirements.txt", "pyproject.toml", "Pipfile", "setup.py"])
    if (PYTHON_AWS.test(readSmall(join(directory, file)) ?? "")) return true
  if (GO_AWS.test(readSmall(join(directory, "go.mod")) ?? "")) return true
  return false
}
