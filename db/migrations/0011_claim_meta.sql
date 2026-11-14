-- 0011_claim_meta: one claim_meta() for confidentiality (0008) and successor findings (0009).
-- Both migrations replaced the function, so the body in force depended on the order they were
-- applied in. This is the union of the two, whatever that order was:
--   * 0008: the role set returned is the effective one (role_set cut down by flag_role_set, the
--     roles that may see a conflicting claim's flag), so "Restricted" is decided on what a role
--     can really read;
--   * 0009: a successor finding that is not approved (or edited) is evidence for nobody, so it is
--     not returned at all.
-- Same signature and columns. Idempotent.
CREATE OR REPLACE FUNCTION claim_meta(ws uuid)
RETURNS TABLE (id text, entity text, attribute text, state text, trust text, role_set text[])
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT c.id, c.entity, c.attribute, c.state, c.trust,
    CASE WHEN c.flag_role_set IS NULL THEN c.role_set
         ELSE ARRAY(SELECT r FROM unnest(c.role_set) AS r WHERE r = ANY(c.flag_role_set)) END
  FROM claims c
  WHERE c.workspace_id = ws
    AND (us_claim('workspace_id') IS NULL OR us_claim('workspace_id')::uuid = ws)
    AND NOT (c.origin = 'successor_finding' AND c.review NOT IN ('approved', 'edited'))
  ORDER BY c.id
$$;
REVOKE ALL ON FUNCTION claim_meta(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION claim_meta(uuid) TO us_reader;
DO $$
BEGIN
  EXECUTE format('GRANT EXECUTE ON FUNCTION claim_meta(uuid) TO %I', current_user);
END $$;
