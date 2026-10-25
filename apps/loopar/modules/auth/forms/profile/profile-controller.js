
'use strict';

import {PageController, loopar} from 'loopar';

export default class ProfileController extends PageController {
  // `update` is a free action (any logged user, no role grant needed) —
  // NOT a public one: public actions skip CSRF, and saving a profile is a
  // state change of the logged user.
  static freeActions = ["view", "update", "setInfo", "changePassword"]
  constructor(props){
    super(props);

    const user = loopar.auth.user();

    if(!user) loopar.throw("Not logued", "/auth/login")
  }

  async actionView(){
    this.client = "profile"
    this.entry = "form"; // desk form; profile-form.jsx sets canUpdate/hasHeader
    const user = await loopar.newDocument("Profile")

    return await super.render(user)
  }

  clientImporter(Document) {
    return "profile-form"
  }

  async actionUpdateInfo(){
    const profile = await loopar.newDocument("Profile");
    await profile.updateInfo(this.body)

    return this.success("Completed")
  }

  async actionChangePassword(){
    const profile = await loopar.newDocument("Profile");
    await profile.changePassword(this.body);

    return this.success("Completed")
  }
}