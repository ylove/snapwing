<?xml version="1.0" encoding="UTF-8"?>
<!--
  Workspace context map, cross-references (main 4.2). Structure is checked by
  workspace-context.xsd, which runs first. Rule contexts select elements, not attributes,
  because the validator never fires a rule whose context is an attribute (build/decisions/0010).
-->
<sch:schema xmlns:sch="http://purl.oclc.org/dsdl/schematron" queryBinding="xslt2">
  <sch:ns prefix="w" uri="urn:snapwing:workspace:v1"/>

  <sch:pattern id="channel-surface">
    <sch:rule context="w:channel">
      <sch:assert id="channel-surface-exists"
                  test="@surface = 'from-payload' or @surface = /w:workspace/w:surfaces/w:surface/@id">Channel <sch:value-of select="@name"/> names surface <sch:value-of select="@surface"/>, which is not declared.</sch:assert>
    </sch:rule>
  </sch:pattern>

  <sch:pattern id="owns-component">
    <sch:rule context="w:person/w:owns">
      <sch:let name="surface" value="@surface"/>
      <sch:let name="component" value="@component"/>
      <sch:assert id="owns-surface-exists"
                  test="$surface = /w:workspace/w:surfaces/w:surface/@id">Person <sch:value-of select="../@handle"/> owns surface <sch:value-of select="@surface"/>, which is not declared.</sch:assert>
      <sch:assert id="owns-component-exists"
                  test="not(@component) or $component = /w:workspace/w:surfaces/w:surface[@id = $surface]/w:components/w:component/@id">Person <sch:value-of select="../@handle"/> owns component <sch:value-of select="@component"/>, which does not exist under surface <sch:value-of select="@surface"/>.</sch:assert>
    </sch:rule>
  </sch:pattern>

  <sch:pattern id="override-refs">
    <sch:rule context="w:overrides/w:surface">
      <sch:let name="ref" value="@ref"/>
      <sch:assert id="override-surface-ref"
                  test="$ref = /w:workspace/w:surfaces/w:surface/@id">Autonomy override refers to surface <sch:value-of select="@ref"/>, which is not declared.</sch:assert>
    </sch:rule>
    <sch:rule context="w:overrides/w:component">
      <sch:let name="surface" value="@surface"/>
      <sch:let name="ref" value="@ref"/>
      <sch:assert id="override-component-surface"
                  test="$surface = /w:workspace/w:surfaces/w:surface/@id">Autonomy override for component <sch:value-of select="@ref"/> names surface <sch:value-of select="@surface"/>, which is not declared.</sch:assert>
      <sch:assert id="override-component-ref"
                  test="$ref = /w:workspace/w:surfaces/w:surface[@id = $surface]/w:components/w:component/@id">Autonomy override refers to component <sch:value-of select="@ref"/>, which does not exist under surface <sch:value-of select="@surface"/>.</sch:assert>
    </sch:rule>
  </sch:pattern>
</sch:schema>
