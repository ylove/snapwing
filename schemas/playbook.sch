<?xml version="1.0" encoding="UTF-8"?>
<!--
  Playbook cross-references and ordering (Companion A 6.2, A 8). Structure is checked by
  playbook.xsd, which runs first.

  A playbook refers to the workspace map (people, surfaces, channels), and the Schematron
  runner validates one document, so loadPlaybook() wraps the playbook and a digest of the map:

    <c:check xmlns:c="urn:snapwing:playbook-check:v1">
      <playbook xmlns="urn:snapwing:playbook:v1">...</playbook>
      <c:map>
        <c:surface id="web"/> <c:person id="U0ENGLEAD"/> <c:channel id="C0WEBBUGS" name="web-bugs"/>
      </c:map>
    </c:check>

  Run on a bare playbook, every reference fails to resolve. Rule contexts select elements, not
  attributes (build/decisions/0010).
-->
<sch:schema xmlns:sch="http://purl.oclc.org/dsdl/schematron" queryBinding="xslt2">
  <sch:ns prefix="p" uri="urn:snapwing:playbook:v1"/>
  <sch:ns prefix="c" uri="urn:snapwing:playbook-check:v1"/>
  <sch:ns prefix="xs" uri="http://www.w3.org/2001/XMLSchema"/>

  <sch:pattern id="mentions">
    <sch:rule context="p:escalation/p:after[@mention]">
      <sch:let name="who" value="substring-after(@mention, '@')"/>
      <sch:assert id="mention-resolves"
                  test="@mention = 'owner' or (starts-with(@mention, '@') and $who != '' and $who = /c:check/c:map/c:person/@id)">Escalation <sch:value-of select="../@name"/> mentions <sch:value-of select="@mention"/>, which is neither "owner" nor a person in the workspace map.</sch:assert>
    </sch:rule>
  </sch:pattern>

  <sch:pattern id="surfaces">
    <sch:rule context="p:forcePush[@surface]">
      <sch:assert id="force-push-surface-exists"
                  test="@surface = /c:check/c:map/c:surface/@id">forcePush names surface <sch:value-of select="@surface"/>, which is not declared in the workspace map.</sch:assert>
    </sch:rule>
    <sch:rule context="p:monitor/p:critical">
      <sch:assert id="critical-surface-exists"
                  test="@surface = /c:check/c:map/c:surface/@id">monitor marks surface <sch:value-of select="@surface"/> critical, but it is not declared in the workspace map.</sch:assert>
    </sch:rule>
  </sch:pattern>

  <sch:pattern id="channels">
    <sch:rule context="p:intent/p:emoji[@channel]">
      <sch:let name="channel" value="replace(@channel, '^#', '')"/>
      <sch:assert id="emoji-channel-exists"
                  test="$channel = /c:check/c:map/c:channel/@name or $channel = /c:check/c:map/c:channel/@id">Emoji <sch:value-of select="@slack"/> is limited to channel <sch:value-of select="@channel"/>, which is not in the workspace map.</sch:assert>
    </sch:rule>
  </sch:pattern>

  <sch:pattern id="escalation-order">
    <sch:rule context="p:escalation/p:after[preceding-sibling::p:after]">
      <sch:assert id="escalation-step-order"
                  test="xs:dayTimeDuration(@duration) ge xs:dayTimeDuration(preceding-sibling::p:after[1]/@duration)">Escalation <sch:value-of select="../@name"/> step <sch:value-of select="@duration"/> is shorter than the step before it (<sch:value-of select="preceding-sibling::p:after[1]/@duration"/>).</sch:assert>
    </sch:rule>
    <sch:rule context="p:escalation/p:after">
      <sch:assert id="escalation-step-action"
                  test="@mention or @pagerduty or @channel">Escalation <sch:value-of select="../@name"/> step <sch:value-of select="@duration"/> has no action (mention, pagerduty, or channel).</sch:assert>
    </sch:rule>
    <sch:rule context="p:escalation/p:applyWhen">
      <sch:assert id="apply-when-condition"
                  test="@priority or @outage or @monitored or @stalled">Escalation <sch:value-of select="../@name"/> has an empty applyWhen.</sch:assert>
    </sch:rule>
  </sch:pattern>

  <sch:pattern id="force-push-shape">
    <sch:rule context="p:forcePush">
      <sch:assert id="force-push-one-of"
                  test="count(@priority | @surface) = 1">forcePush needs exactly one of priority and surface.</sch:assert>
    </sch:rule>
  </sch:pattern>
</sch:schema>
