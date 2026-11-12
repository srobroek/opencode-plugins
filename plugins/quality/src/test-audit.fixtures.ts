/** Small JUnit reports as the supported tools write them (pytest, Vitest, bun and gotestsum captured from real runs; nextest from its docs). */

export const PYTEST = `<?xml version="1.0" encoding="utf-8"?><testsuites name="pytest tests"><testsuite name="pytest" errors="1" failures="1" skipped="1" tests="4" time="0.035"><testcase classname="test_a.TestX" name="test_ok" time="0.000" /><testcase classname="test_a.TestX" name="test_bad" time="0.010"><failure message="assert 1 == 2">E   assert 1 == 2</failure></testcase><testcase classname="test_a.TestX" name="test_sk" time="0.000"><skipped type="pytest.skip" message="r">skipped</skipped></testcase><testcase classname="test_a.TestX" name="test_err" time="0.000"><error message="fixture not found">E fixture 'nofixture' not found</error></testcase></testsuite></testsuites>`

export const VITEST = `<?xml version="1.0" encoding="UTF-8" ?>
<testsuites name="vitest tests" tests="3" failures="1" errors="0" time="0.0046">
    <testsuite name="a.test.js" tests="3" failures="1" errors="0" skipped="1" time="0.0046">
        <testcase classname="a.test.js" name="suite &gt; ok" time="0.00066">
        </testcase>
        <testcase classname="a.test.js" name="suite &gt; bad" time="0.0032">
            <failure message="expected 1 to be 2 // Object.is equality" type="AssertionError">AssertionError</failure>
        </testcase>
        <testcase classname="a.test.js" name="suite &gt; sk" time="0">
            <skipped/>
        </testcase>
    </testsuite>
</testsuites>`

export const BUN = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="bun test" tests="3" assertions="1" failures="1" skipped="1" time="0.0125">
  <testsuite name="a.test.ts" file="a.test.ts" tests="3" failures="1" skipped="1" time="0.0019">
    <testsuite name="suite" file="a.test.ts" line="2" tests="3" failures="1" skipped="1" time="0">
      <testcase name="ok" classname="suite" time="0.000003" file="a.test.ts" line="2" assertions="0" />
      <testcase name="bad" classname="suite" time="0.000481" file="a.test.ts" line="2" assertions="1">
        <failure type="AssertionError" message="expect(received).toBe(expected)">AssertionError</failure>
      </testcase>
      <testcase name="sk" classname="suite" time="0" file="a.test.ts" line="2" assertions="0">
        <skipped />
      </testcase>
    </testsuite>
  </testsuite>
</testsuites>`

export const GOTESTSUM = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites tests="4" failures="1" errors="0" time="1.139868">
	<testsuite tests="4" failures="1" skipped="1" time="1.140000" name="ex.com/m">
		<properties><property name="go.version" value="go1.27.4 darwin/arm64"></property></properties>
		<testcase classname="ex.com/m" name="TestBad" time="0.000000">
			<failure message="Failed" type="">=== RUN   TestBad</failure>
		</testcase>
		<testcase classname="ex.com/m" name="TestSk" time="0.000000">
			<skipped message="=== RUN   TestSk"></skipped>
		</testcase>
		<testcase classname="ex.com/m" name="TestOk/sub" time="0.000000"></testcase>
		<testcase classname="ex.com/m" name="TestOk" time="0.000000"></testcase>
	</testsuite>
</testsuites>`

export const NEXTEST = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="nextest-run" tests="3" failures="1" errors="0" time="0.023">
    <testsuite name="fixture-project::basic" tests="3" disabled="0" errors="0" failures="1">
        <testcase name="test_cwd" classname="fixture-project::basic" time="0.004">
        </testcase>
        <testcase name="test_failure_assert" classname="fixture-project::basic" time="0.004">
            <failure type="test failure">thread panicked</failure>
            <rerunFailure time="0.004" type="test failure">thread panicked
                <system-out>out</system-out>
            </rerunFailure>
        </testcase>
        <testcase name="test_flaky_mod_4" classname="fixture-project::basic" time="0.004">
            <flakyFailure time="0.004" type="test failure">attempt 1</flakyFailure>
            <flakyFailure time="0.004" type="test failure">attempt 2</flakyFailure>
        </testcase>
    </testsuite>
</testsuites>`
