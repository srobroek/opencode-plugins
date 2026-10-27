import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { isAwsProject } from "./detect.ts"

const root = mkdtempSync(join(tmpdir(), "aws-detect-"))
afterAll(() => rmSync(root, { recursive: true, force: true }))
let count = 0

function project(files: Record<string, string>): string {
  const dir = join(root, String(++count))
  mkdirSync(dir)
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, file)), { recursive: true })
    writeFileSync(join(dir, file), text)
  }
  return dir
}

describe("isAwsProject", () => {
  test.each([
    ["cdk.json", { "cdk.json": "{}" }],
    ["SAM config", { "samconfig.toml": "" }],
    ["SAM build dir", { ".aws-sam/build.toml": "" }],
    ["serverless", { "serverless.yml": "service: x" }],
    ["Terraform at the root", { "main.tf": 'provider "aws" {\n  region = "eu-west-1"\n}' }],
    ["Terraform in infra/", { "infra/versions.tf": 'source = "hashicorp/aws"' }],
    ["CloudFormation template", { "template.yaml": "AWSTemplateFormatVersion: '2010-09-09'" }],
    ["Pulumi stack", { "Pulumi.yaml": "name: x", "Pulumi.dev.yaml": "config:\n  aws:region: us-east-1" }],
    ["npm CDK", { "package.json": '{"dependencies":{"aws-cdk-lib":"2"}}' }],
    ["npm SDK", { "package.json": '{"dependencies":{"@aws-sdk/client-s3":"3"}}' }],
    ["boto3", { "requirements.txt": "boto3==1.40\n" }],
    ["Go SDK", { "go.mod": "require github.com/aws/aws-sdk-go-v2 v1.30.0" }],
  ])("%s", (_, files) => {
    expect(isAwsProject(project(files))).toBe(true)
  })

  test.each([
    ["empty", {}],
    ["GCP Terraform", { "main.tf": 'provider "google" {}' }],
    ["unrelated template", { "template.yaml": "kind: Deployment" }],
    ["plain npm", { "package.json": '{"dependencies":{"react":"19"}}' }],
    ["Pulumi on Azure", { "Pulumi.yaml": "name: x", "Pulumi.dev.yaml": "config:\n  azure-native:location: x" }],
  ])("not %s", (_, files) => {
    expect(isAwsProject(project(files))).toBe(false)
  })
})
