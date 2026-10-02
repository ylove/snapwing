<?xml version="1.0" encoding="UTF-8"?>
<!-- Test fixture: cross-reference rules for the miniature workspace schema. -->
<sch:schema xmlns:sch="http://purl.oclc.org/dsdl/schematron" queryBinding="xslt2">
  <sch:ns prefix="m" uri="urn:snapwing:test:mini:v1"/>
  <sch:pattern id="channel-surface">
    <sch:rule context="m:channel">
      <sch:assert id="channel-surface-exists" test="@surface = /m:workspace/m:surface/@id">Channel <sch:value-of select="@name"/> names surface <sch:value-of select="@surface"/>, which is not declared.</sch:assert>
    </sch:rule>
  </sch:pattern>
  <sch:pattern id="unique-surface">
    <sch:rule context="m:surface">
      <sch:let name="id" value="@id"/>
      <sch:report id="surface-duplicate" test="count(/m:workspace/m:surface[@id = $id]) &gt; 1">Surface <sch:value-of select="@id"/> is declared more than once.</sch:report>
    </sch:rule>
  </sch:pattern>
</sch:schema>
